import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  IdV2MigrationError,
  type BookMigrationResult,
  type IdV2MigrationDependencies,
  type MigrateBookOptions,
  type MigrationRunStatus,
  type RollbackBookOptions,
} from './contracts.js';
import {
  activeBookWork,
  bookSnapshotStateHash,
  hasActiveBookWork,
  loadBookSnapshot,
  type BookBackupTable,
} from './book-snapshot.js';
import { buildBookMigrationPlan } from './book-plan.js';
import { cutoverBookMigration, deleteBookDependents, insertBookRecordset, stageBookAliases } from './book-cutover.js';
import { safeErrorCode, safeErrorDetails, type JsonRecord } from './safe-values.js';

interface RunRow extends pg.QueryResultRow {
  id: string;
  source_book_id: string | null;
  canonical_book_id: string | null;
  status: MigrationRunStatus;
  report: JsonRecord;
  activated_at: Date | string | null;
}

interface AliasRow extends pg.QueryResultRow {
  user_id: string;
  run_id: string;
  source_book_id: string;
  canonical_book_id: string;
  alias_complete: boolean;
  status: string;
}

interface BackupRow extends pg.QueryResultRow {
  table_name: BookBackupTable;
  row_data: JsonRecord;
}

const RESTORE_ORDER: readonly BookBackupTable[] = [
  'library_books',
  'chapters',
  'paragraph_pages',
  'paragraph_search',
  'reading_positions',
  'bookmarks',
  'highlights',
  'notes',
  'characters',
  'character_aliases',
  'character_relations',
  'analysis_runs',
  'chapter_contexts',
  'voice_profiles',
  'labeled_segments',
  'user_corrections',
  'book_ai_workflows',
  'provider_jobs',
  'provider_job_attempts',
  'provider_job_outbox',
  'book_ai_workflow_jobs',
  'sync_events',
  'tts_audio_cache',
] as const;

async function transaction<T>(client: pg.PoolClient, operation: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    const result = await operation();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

async function lock(client: pg.PoolClient, userId: string, bookId: string): Promise<void> {
  await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [`id-v2:${userId}:${bookId}`]);
}

async function unlock(client: pg.PoolClient, userId: string, bookId: string): Promise<void> {
  await client
    .query('select pg_advisory_unlock(hashtextextended($1, 0))', [`id-v2:${userId}:${bookId}`])
    .catch(() => undefined);
}

async function completeAlias(
  client: pg.PoolClient,
  userId: string,
  sourceBookId: string,
): Promise<AliasRow | undefined> {
  const result = await client.query<AliasRow>(
    `
      select user_id, run_id, source_book_id, canonical_book_id, alias_complete, status
      from id_v2_book_aliases
      where user_id = $1 and source_book_id = $2 and status = 'active' and alias_complete
    `,
    [userId, sourceBookId],
  );
  return result.rows[0];
}

async function reusableRun(client: pg.PoolClient, userId: string, sourceBookId: string): Promise<RunRow | undefined> {
  const result = await client.query<RunRow>(
    `
      select id, source_book_id, canonical_book_id, status, report, activated_at
      from id_v2_migration_runs
      where migration_kind = 'book'
        and user_id = $1
        and source_book_id = $2
        and status in ('pending', 'running', 'deferred', 'staged')
      order by created_at desc
      limit 1
    `,
    [userId, sourceBookId],
  );
  return result.rows[0];
}

async function ensureRun(client: pg.PoolClient, userId: string, sourceBookId: string): Promise<RunRow> {
  const existing = await reusableRun(client, userId, sourceBookId);
  if (existing) {
    await client.query(
      `
        update id_v2_migration_runs
        set status = 'running', error_code = null, started_at = coalesce(started_at, now()), updated_at = now()
        where id = $1
      `,
      [existing.id],
    );
    return { ...existing, status: 'running' };
  }

  const id = randomUUID();
  const inserted = await client.query<RunRow>(
    `
      insert into id_v2_migration_runs (
        id, migration_kind, user_id, source_book_id, status, started_at
      ) values ($1, 'book', $2, $3, 'running', now())
      returning id, source_book_id, canonical_book_id, status, report, activated_at
    `,
    [id, userId, sourceBookId],
  );
  return inserted.rows[0];
}

async function markDeferred(
  client: pg.PoolClient,
  runId: string,
  active: Record<string, number>,
): Promise<BookMigrationResult> {
  const report = { activeWork: active, retryable: true };
  await client.query(
    `
      update id_v2_migration_runs
      set status = 'deferred', report = $2::jsonb, error_code = 'book_work_active', updated_at = now()
      where id = $1
    `,
    [runId, JSON.stringify(report)],
  );
  const source = await client.query<{ source_book_id: string }>(
    'select source_book_id from id_v2_migration_runs where id = $1',
    [runId],
  );
  return {
    runId,
    sourceBookId: source.rows[0]?.source_book_id ?? '',
    status: 'deferred',
    report,
  };
}

const QUARANTINE_CODES = new Set([
  'canonical_book_collision',
  'canonical_object_collision',
  'chapter_range_invalid',
  'content_count_mismatch',
  'identity_alias_missing',
  'identity_reference_ambiguous',
  'identity_reference_missing',
  'identity_semantic_collision',
  'identity_source_collision',
  'hash_reference_ambiguous',
  'migration_row_invalid',
  'page_json_invalid',
  'paragraph_duplicate',
  'paragraph_order_invalid',
  'search_paragraph_missing',
  'source_hash_mismatch',
  'source_hash_unknown',
  'source_object_missing',
  'source_object_size_mismatch',
  'workflow_plan_invalid',
]);

function shouldQuarantine(code: string): boolean {
  return QUARANTINE_CODES.has(code);
}

async function recordFailure(
  client: pg.PoolClient,
  run: RunRow,
  userId: string,
  sourceBookId: string,
  error: unknown,
): Promise<BookMigrationResult> {
  const code = safeErrorCode(error);
  const details = safeErrorDetails(error);
  const status: MigrationRunStatus = shouldQuarantine(code) ? 'quarantined' : 'failed';
  await transaction(client, async () => {
    if (status === 'quarantined') {
      await client.query(
        `
          insert into id_v2_migration_quarantine (
            run_id, user_id, source_book_id, entity_type, source_id, reason_code, safe_details
          ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
        `,
        [
          run.id,
          userId,
          sourceBookId,
          typeof details.entityType === 'string' ? details.entityType : 'book',
          typeof details.sourceId === 'string' ? details.sourceId : sourceBookId,
          code,
          JSON.stringify(details),
        ],
      );
      await client.query(
        `
          insert into id_v2_book_aliases (
            user_id, source_book_id, canonical_book_id, source_file_name,
            source_normalized_text_hash, canonical_normalized_text_hash,
            run_id, status, alias_complete
          )
          select user_id, id, id, source_file_name, normalized_text_hash, normalized_text_hash,
                 $3, 'quarantined', false
          from library_books
          where user_id = $1 and id = $2
          on conflict (user_id, source_book_id) do update
          set run_id = excluded.run_id, status = 'quarantined', alias_complete = false, updated_at = now()
        `,
        [userId, sourceBookId, run.id],
      );
    }
    await client.query(
      `
        update id_v2_migration_runs
        set status = $2, error_code = $3, report = $4::jsonb, finished_at = now(), updated_at = now()
        where id = $1
      `,
      [run.id, status, code, JSON.stringify({ errorCode: code, ...details })],
    );
  });
  return {
    runId: run.id,
    sourceBookId,
    canonicalBookId: run.canonical_book_id ?? undefined,
    status,
    report: { errorCode: code, ...details },
  };
}

async function activatedResult(client: pg.PoolClient, alias: AliasRow): Promise<BookMigrationResult> {
  const run = await client.query<RunRow>(
    'select id, source_book_id, canonical_book_id, status, report, activated_at from id_v2_migration_runs where id = $1',
    [alias.run_id],
  );
  return {
    runId: alias.run_id,
    sourceBookId: alias.source_book_id,
    canonicalBookId: alias.canonical_book_id,
    status: 'activated',
    report: run.rows[0]?.report ?? {},
  };
}

export class IdV2MigrationService {
  constructor(private readonly dependencies: IdV2MigrationDependencies) {}

  async migrateBook(options: MigrateBookOptions): Promise<BookMigrationResult> {
    const client = await this.dependencies.pool.connect();
    let locked = false;
    try {
      await lock(client, options.userId, options.sourceBookId);
      locked = true;
      const alias = await completeAlias(client, options.userId, options.sourceBookId);
      if (alias) return await activatedResult(client, alias);

      const run = await ensureRun(client, options.userId, options.sourceBookId);
      const active = await activeBookWork(client, options.userId, options.sourceBookId);
      if (hasActiveBookWork(active)) return await markDeferred(client, run.id, active);

      try {
        const rows = await loadBookSnapshot(client, options.userId, options.sourceBookId);
        const plan = await buildBookMigrationPlan({
          runId: run.id,
          userId: options.userId,
          rows,
          identities: this.dependencies.identities,
          sourceLoader: this.dependencies.sourceLoader,
        });
        await transaction(client, () => stageBookAliases(client, plan));
        if (options.stopAfterStage === 'planned') {
          return {
            runId: run.id,
            sourceBookId: plan.sourceBookId,
            canonicalBookId: plan.canonicalBookId,
            status: 'staged',
            report: plan.report,
          };
        }
        const activatedReport = await transaction(client, () => cutoverBookMigration(client, plan));
        this.dependencies.logger?.info('ID v2 book migration activated.');
        return {
          runId: run.id,
          sourceBookId: plan.sourceBookId,
          canonicalBookId: plan.canonicalBookId,
          status: 'activated',
          report: activatedReport,
        };
      } catch (error) {
        this.dependencies.logger?.warn(`ID v2 book migration stopped: ${safeErrorCode(error)}.`);
        if (safeErrorCode(error) === 'book_work_active') {
          const currentActive = await activeBookWork(client, options.userId, options.sourceBookId);
          return await markDeferred(client, run.id, currentActive);
        }
        return await recordFailure(client, run, options.userId, options.sourceBookId, error);
      }
    } finally {
      if (locked) await unlock(client, options.userId, options.sourceBookId);
      client.release();
    }
  }

  async recoverForward(options: RollbackBookOptions): Promise<BookMigrationResult> {
    const client = await this.dependencies.pool.connect();
    let locked = false;
    try {
      await lock(client, options.userId, options.sourceBookId);
      locked = true;
      const alias = await completeAlias(client, options.userId, options.sourceBookId);
      if (!alias) {
        throw new IdV2MigrationError('forward_recovery_unavailable', 'No migration state is available.');
      }
      const verified = await client.query(
        `
          select 1
          from library_books
          where user_id = $1
            and id = $2
            and id_contract = 'v2-sha256-128'
            and hash_contract = 'v2-sha256-tagged'
        `,
        [options.userId, alias.canonical_book_id],
      );
      if (verified.rowCount !== 1) {
        throw new IdV2MigrationError('forward_recovery_incomplete', 'The canonical book is incomplete.');
      }
      await client.query(
        `
          update id_v2_migration_runs
          set report = coalesce(report, '{}'::jsonb) || $2::jsonb, updated_at = now()
          where id = $1
        `,
        [alias.run_id, JSON.stringify({ forwardVerifiedAt: new Date().toISOString() })],
      );
      return await activatedResult(client, alias);
    } finally {
      if (locked) await unlock(client, options.userId, options.sourceBookId);
      client.release();
    }
  }

  async rollbackBook(options: RollbackBookOptions): Promise<BookMigrationResult> {
    const client = await this.dependencies.pool.connect();
    let locked = false;
    try {
      await lock(client, options.userId, options.sourceBookId);
      locked = true;
      const alias = await completeAlias(client, options.userId, options.sourceBookId);
      if (!alias) {
        throw new IdV2MigrationError('rollback_alias_missing', 'No active migration alias can be rolled back.');
      }
      const runResult = await client.query<RunRow>(
        `
          select id, source_book_id, canonical_book_id, status, report, activated_at
          from id_v2_migration_runs where id = $1
        `,
        [alias.run_id],
      );
      const run = runResult.rows[0];
      if (!run?.activated_at || run.status !== 'activated') {
        throw new IdV2MigrationError('rollback_state_invalid', 'The migration is not in an activated state.');
      }
      await transaction(client, async () => {
        await this.assertRollbackSafe(client, alias, run);
        const backups = await client.query<BackupRow>(
          `
            select table_name, row_data
            from id_v2_migration_backups
            where run_id = $1
            order by restore_order, table_name, source_key
          `,
          [run.id],
        );
        if (backups.rows.length === 0) {
          throw new IdV2MigrationError('rollback_backup_missing', 'Rollback material is unavailable.');
        }
        await this.restoreBackups(client, alias, run.id, backups.rows);
      });
      return {
        runId: run.id,
        sourceBookId: alias.source_book_id,
        canonicalBookId: alias.canonical_book_id,
        status: 'rolled_back',
        report: { rollback: 'completed' },
      };
    } finally {
      if (locked) await unlock(client, options.userId, options.sourceBookId);
      client.release();
    }
  }

  private async assertRollbackSafe(client: pg.PoolClient, alias: AliasRow, run: RunRow): Promise<void> {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 764173))', [alias.user_id]);
    const expectedStateHash = typeof run.report.activatedStateHash === 'string' ? run.report.activatedStateHash : '';
    if (!expectedStateHash) {
      throw new IdV2MigrationError(
        'rollback_requires_forward_recovery',
        'Activated state evidence is unavailable; recover forward instead.',
      );
    }

    const active = await activeBookWork(client, alias.user_id, alias.canonical_book_id);
    if (hasActiveBookWork(active)) {
      throw new IdV2MigrationError('book_work_active', 'The book has active work and cannot be rolled back.', {
        activeWork: active,
      });
    }
    const currentRows = await loadBookSnapshot(client, alias.user_id, alias.canonical_book_id, true);
    if (bookSnapshotStateHash(currentRows) !== expectedStateHash) {
      throw new IdV2MigrationError(
        'rollback_requires_forward_recovery',
        'Canonical data changed after cutover; recover forward instead.',
      );
    }

    const bookAlias = await client.query<{
      source_object_id: string | null;
      canonical_object_id: string | null;
    }>(
      `
        select source_object_id, canonical_object_id
        from id_v2_book_aliases
        where user_id = $1 and source_book_id = $2
      `,
      [alias.user_id, alias.source_book_id],
    );
    const object = bookAlias.rows[0];
    if (object?.source_object_id && object.canonical_object_id !== object.source_object_id) {
      const shared = await client.query('select 1 from library_books where object_id = $1 and id <> $2 limit 1', [
        object.canonical_object_id,
        alias.canonical_book_id,
      ]);
      if (shared.rowCount) {
        throw new IdV2MigrationError(
          'rollback_shared_object_requires_forward_recovery',
          'A canonical object is shared; recover forward instead.',
        );
      }
    }
  }

  private async restoreBackups(
    client: pg.PoolClient,
    alias: AliasRow,
    runId: string,
    backups: readonly BackupRow[],
  ): Promise<void> {
    const grouped = new Map<BookBackupTable, JsonRecord[]>();
    for (const backup of backups) {
      const rows = grouped.get(backup.table_name) ?? [];
      rows.push(backup.row_data);
      grouped.set(backup.table_name, rows);
    }
    await deleteBookDependents(client, alias.canonical_book_id);
    await client.query('delete from library_books where id = $1', [alias.canonical_book_id]);

    const objectRows = grouped.get('book_objects') ?? [];
    const sourceObject = objectRows[0];
    if (sourceObject) {
      const canonicalObjectId = (
        await client.query<{ canonical_object_id: string | null }>(
          'select canonical_object_id from id_v2_book_aliases where run_id = $1',
          [runId],
        )
      ).rows[0]?.canonical_object_id;
      if (canonicalObjectId && canonicalObjectId !== sourceObject.id) {
        await client.query('delete from book_objects where id = $1', [canonicalObjectId]);
        await insertBookRecordset(client, 'book_objects', objectRows);
      } else {
        await client.query(
          `
            update book_objects current_object
            set raw_text_hash = restored.raw_text_hash,
                storage_key = restored.storage_key,
                file_name = restored.file_name,
                content_type = restored.content_type,
                size_bytes = restored.size_bytes,
                id_contract = restored.id_contract,
                hash_contract = restored.hash_contract
            from jsonb_populate_record(null::book_objects, $2::jsonb) restored
            where current_object.id = $1
          `,
          [sourceObject.id, JSON.stringify(sourceObject)],
        );
      }
    }

    for (const table of RESTORE_ORDER) {
      const rows = grouped.get(table) ?? [];
      if (table === 'upload_sessions') continue;
      if (table === 'import_jobs') continue;
      await insertBookRecordset(client, table, rows);
    }
    for (const row of grouped.get('upload_sessions') ?? []) {
      await client.query(
        `
          update upload_sessions
          set client_book_id = $2, client_hash_hint = $3, updated_at = $4
          where id = $1
        `,
        [row.id, row.client_book_id ?? null, row.client_hash_hint ?? null, row.updated_at],
      );
    }
    for (const row of grouped.get('import_jobs') ?? []) {
      await client.query('update import_jobs set book_id = $2, updated_at = $3 where id = $1', [
        row.id,
        row.book_id ?? null,
        row.updated_at,
      ]);
    }
    await client.query(
      `
        update id_v2_book_aliases
        set status = 'rolled_back', alias_complete = false, updated_at = now()
        where run_id = $1;
      `,
      [runId],
    );
    await client.query(
      `
        update id_v2_entity_aliases
        set status = 'rolled_back', alias_complete = false, updated_at = now()
        where run_id = $1
      `,
      [runId],
    );
    await client.query(
      `
        update id_v2_tts_cache_quarantine
        set restored_at = now()
        where run_id = $1
      `,
      [runId],
    );
    await client.query(
      `
        update id_v2_migration_runs
        set status = 'rolled_back', report = report || '{"rollback":"completed"}'::jsonb,
            finished_at = now(), updated_at = now()
        where id = $1
      `,
      [runId],
    );
  }
}
