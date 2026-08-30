import type pg from 'pg';
import type { BookMigrationPlan, EntityAlias } from './contracts.js';
import { IdV2MigrationError } from './contracts.js';
import {
  BOOK_BACKUP_TABLE_ORDER,
  activeBookWork,
  bookSnapshotFingerprint,
  bookSnapshotStateHash,
  hasActiveBookWork,
  loadBookSnapshot,
  type BookBackupTable,
  type BookSnapshotRows,
} from './book-snapshot.js';

const INSERT_ORDER: readonly BookBackupTable[] = [
  'chapters',
  'paragraph_pages',
  'paragraph_search',
  'reading_positions',
  'fixed_document_section_read_states',
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
] as const;

const RECORDSET_BATCH_SIZE = 500;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

function sourceKey(table: BookBackupTable, row: Record<string, unknown>): string {
  if (typeof row.id === 'string') return row.id;
  if (table === 'reading_positions') return JSON.stringify([row.book_id, row.user_id]);
  if (table === 'fixed_document_section_read_states') {
    return JSON.stringify([row.book_id, row.user_id, row.document_section_id]);
  }
  if (table === 'sync_events') return String(row.sequence);
  return JSON.stringify(row);
}

async function saveBackups(client: pg.PoolClient, runId: string, rows: BookSnapshotRows): Promise<void> {
  for (const [restoreOrder, table] of BOOK_BACKUP_TABLE_ORDER.entries()) {
    const tableRows = rows[table];
    if (tableRows.length === 0) continue;
    const keys = tableRows.map((row) => sourceKey(table, row));
    await client.query(
      `
        insert into id_v2_migration_backups (
          run_id, table_name, source_key, restore_order, row_data
        )
        select $1, $2, backup.source_key, $3, backup.row_data
        from unnest($4::text[], $5::jsonb[]) as backup(source_key, row_data)
        on conflict (run_id, table_name, source_key) do nothing
      `,
      [runId, table, restoreOrder, keys, tableRows.map((row) => JSON.stringify(row))],
    );
  }
}

async function ensureCanonicalObject(client: pg.PoolClient, plan: BookMigrationPlan): Promise<void> {
  if (!plan.sourceObjectId || !plan.canonicalObjectId) return;
  const canonical = plan.rows.book_objects[0];
  const target = await client.query<{ id: string; raw_text_hash: string }>(
    'select id, raw_text_hash from book_objects where id = $1 for update',
    [plan.canonicalObjectId],
  );
  if (target.rows[0] && target.rows[0].id !== plan.sourceObjectId) {
    if (target.rows[0].raw_text_hash !== canonical.raw_text_hash) {
      throw new IdV2MigrationError('canonical_object_collision', 'The canonical object ID is already in use.', {
        entityType: 'object',
        sourceId: plan.sourceObjectId,
      });
    }
    return;
  }

  const updated = await client.query(
    `
      update book_objects
      set id = $2,
          raw_text_hash = $3,
          id_contract = 'v2-sha256-128',
          hash_contract = 'v2-sha256-tagged'
      where id = $1
    `,
    [plan.sourceObjectId, plan.canonicalObjectId, canonical.raw_text_hash],
  );
  if (updated.rowCount !== 1) {
    throw new IdV2MigrationError('source_object_changed', 'The source object changed before cutover.');
  }
}

async function establishCanonicalBook(client: pg.PoolClient, plan: BookMigrationPlan): Promise<void> {
  const row = plan.rows.library_books[0];
  if (plan.sourceBookId === plan.canonicalBookId) {
    const updated = await client.query(
      `
        update library_books
        set object_id = $3,
            normalized_text_hash = $4,
            id_contract = 'v2-sha256-128',
            hash_contract = 'v2-sha256-tagged',
            identity_migration_run_id = $5
        where user_id = $1 and id = $2
      `,
      [plan.userId, plan.sourceBookId, row.object_id, row.normalized_text_hash, plan.runId],
    );
    if (updated.rowCount !== 1) {
      throw new IdV2MigrationError('source_book_changed', 'The source book changed before cutover.');
    }
    return;
  }

  const target = await client.query('select 1 from library_books where id = $1', [plan.canonicalBookId]);
  if (target.rowCount) {
    throw new IdV2MigrationError('canonical_book_collision', 'The canonical book ID is already in use.', {
      entityType: 'book',
      sourceId: plan.sourceBookId,
    });
  }
  await insertBookRecordset(client, 'library_books', [row]);
}

async function quarantineTtsRows(client: pg.PoolClient, plan: BookMigrationPlan): Promise<void> {
  for (const batch of chunks(plan.quarantinedTtsRows, RECORDSET_BATCH_SIZE)) {
    await client.query(
      `
        insert into id_v2_tts_cache_quarantine (
          run_id, user_id, source_book_id, canonical_book_id, cache_id, row_data
        )
        select
          $1, $2, $3, $4,
          cache_row->>'id',
          cache_row
        from jsonb_array_elements($5::jsonb) cache_row
        on conflict (run_id, cache_id) do nothing
      `,
      [plan.runId, plan.userId, plan.sourceBookId, plan.canonicalBookId, JSON.stringify(batch)],
    );
  }
}

export async function deleteBookDependents(client: pg.PoolClient, sourceBookId: string): Promise<void> {
  const statements = [
    'delete from provider_job_outbox where provider_job_id in (select id from provider_jobs where book_id = $1)',
    'delete from provider_job_attempts where provider_job_id in (select id from provider_jobs where book_id = $1)',
    `delete from book_ai_workflow_jobs
       where workflow_id in (select id from book_ai_workflows where book_id = $1)
          or provider_job_id in (select id from provider_jobs where book_id = $1)`,
    'delete from tts_audio_cache where book_id = $1',
    'delete from user_corrections where book_id = $1',
    'delete from labeled_segments where book_id = $1',
    'delete from chapter_contexts where book_id = $1',
    'delete from voice_profiles where book_id = $1',
    'delete from character_relations where book_id = $1',
    'delete from character_aliases where book_id = $1',
    'delete from analysis_runs where book_id = $1',
    'delete from characters where book_id = $1',
    'delete from provider_jobs where book_id = $1',
    'delete from book_ai_workflows where book_id = $1',
    'delete from sync_events where book_id = $1',
    'delete from notes where book_id = $1',
    'delete from highlights where book_id = $1',
    'delete from bookmarks where book_id = $1',
    'delete from fixed_document_section_read_states where book_id = $1',
    'delete from reading_positions where book_id = $1',
    'delete from paragraph_search where book_id = $1',
    'delete from paragraph_pages where book_id = $1',
    'delete from chapters where book_id = $1',
  ];
  for (const statement of statements) await client.query(statement, [sourceBookId]);
}

export async function insertBookRecordset(
  client: pg.PoolClient,
  table: BookBackupTable,
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  for (const batch of chunks(rows, RECORDSET_BATCH_SIZE)) {
    if (batch.length === 0) continue;
    await client.query(
      `
        insert into ${table}
        select populated.*
        from jsonb_populate_recordset(null::${table}, $1::jsonb) populated
      `,
      [JSON.stringify(batch)],
    );
  }
}

async function updateExternalReferences(client: pg.PoolClient, plan: BookMigrationPlan): Promise<void> {
  await client.query(
    `update upload_sessions
     set client_book_id = $3,
         client_hash_hint = case when client_hash_hint is null then null else $4 end,
         updated_at = now()
     where user_id = $1 and client_book_id = $2`,
    [plan.userId, plan.sourceBookId, plan.canonicalBookId, plan.canonicalNormalizedTextHash],
  );
  await client.query(
    `update import_jobs
     set book_id = $3, updated_at = now()
     where user_id = $1 and book_id = $2`,
    [plan.userId, plan.sourceBookId, plan.canonicalBookId],
  );
}

async function saveAliases(client: pg.PoolClient, plan: BookMigrationPlan, complete: boolean): Promise<void> {
  await client.query(
    `
      insert into id_v2_book_aliases (
        user_id, source_book_id, canonical_book_id, source_file_name,
        source_normalized_text_hash, canonical_normalized_text_hash,
        source_object_id, canonical_object_id, run_id, status, alias_complete
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10)
      on conflict (user_id, source_book_id) do update
      set canonical_book_id = excluded.canonical_book_id,
          source_file_name = excluded.source_file_name,
          source_normalized_text_hash = excluded.source_normalized_text_hash,
          canonical_normalized_text_hash = excluded.canonical_normalized_text_hash,
          source_object_id = excluded.source_object_id,
          canonical_object_id = excluded.canonical_object_id,
          run_id = excluded.run_id,
          status = 'active',
          alias_complete = excluded.alias_complete,
          updated_at = now()
    `,
    [
      plan.userId,
      plan.sourceBookId,
      plan.canonicalBookId,
      plan.sourceFileName,
      plan.sourceNormalizedTextHash,
      plan.canonicalNormalizedTextHash,
      plan.sourceObjectId ?? null,
      plan.canonicalObjectId ?? null,
      plan.runId,
      complete,
    ],
  );

  for (const batch of chunks(plan.aliases, RECORDSET_BATCH_SIZE)) {
    await client.query(
      `
        insert into id_v2_entity_aliases (
          user_id, source_book_id, canonical_book_id, entity_type,
          source_id, canonical_id, run_id, status, alias_complete
        )
        select $1, $2, $3, alias.entity_type, alias.source_id, alias.canonical_id, $4, 'active', $5
        from jsonb_to_recordset($6::jsonb) as alias(
          entity_type text, source_id text, canonical_id text
        )
        on conflict (user_id, source_book_id, entity_type, source_id) do update
        set canonical_book_id = excluded.canonical_book_id,
            canonical_id = excluded.canonical_id,
            run_id = excluded.run_id,
            status = 'active',
            alias_complete = excluded.alias_complete,
            updated_at = now()
      `,
      [
        plan.userId,
        plan.sourceBookId,
        plan.canonicalBookId,
        plan.runId,
        complete,
        JSON.stringify(
          batch.map((alias: EntityAlias) => ({
            entity_type: alias.entityType,
            source_id: alias.sourceId,
            canonical_id: alias.canonicalId,
          })),
        ),
      ],
    );
  }
}

export async function stageBookAliases(client: pg.PoolClient, plan: BookMigrationPlan): Promise<void> {
  await saveAliases(client, plan, false);
  await client.query(
    `
      insert into id_v2_migration_checkpoints (run_id, stage, cursor, completed)
      values ($1, 'planned', $2::jsonb, true)
      on conflict (run_id, stage) do update
      set cursor = excluded.cursor, completed = true, updated_at = now()
    `,
    [
      plan.runId,
      JSON.stringify({
        sourceFingerprint: plan.sourceFingerprint,
        canonicalBookId: plan.canonicalBookId,
        aliasCount: plan.aliases.length,
      }),
    ],
  );
  await client.query(
    `
      update id_v2_migration_runs
      set status = 'staged',
          canonical_book_id = $2,
          source_fingerprint = $3::jsonb,
          report = $4::jsonb,
          error_code = null,
          updated_at = now()
      where id = $1
    `,
    [plan.runId, plan.canonicalBookId, JSON.stringify(plan.sourceFingerprint), JSON.stringify(plan.report)],
  );
}

export async function cutoverBookMigration(
  client: pg.PoolClient,
  plan: BookMigrationPlan,
): Promise<Record<string, unknown>> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 764173))', [plan.userId]);
  const currentRows = await loadBookSnapshot(client, plan.userId, plan.sourceBookId, true);
  const active = await activeBookWork(client, plan.userId, plan.sourceBookId);
  if (hasActiveBookWork(active)) {
    throw new IdV2MigrationError('book_work_active', 'The book has active work and must be retried later.', {
      activeWork: active,
    });
  }
  const currentFingerprint = bookSnapshotFingerprint(currentRows);
  if (currentFingerprint.fingerprint !== plan.sourceFingerprint.fingerprint) {
    throw new IdV2MigrationError('source_fingerprint_changed', 'The source book changed after planning.');
  }

  await saveBackups(client, plan.runId, currentRows);
  await ensureCanonicalObject(client, plan);
  await establishCanonicalBook(client, plan);
  await quarantineTtsRows(client, plan);
  await deleteBookDependents(client, plan.sourceBookId);

  for (const table of INSERT_ORDER) {
    await insertBookRecordset(client, table, plan.rows[table]);
  }
  await updateExternalReferences(client, plan);

  if (plan.sourceBookId !== plan.canonicalBookId) {
    await client.query('delete from library_books where user_id = $1 and id = $2', [plan.userId, plan.sourceBookId]);
  }
  if (plan.sourceObjectId && plan.sourceObjectId !== plan.canonicalObjectId) {
    await client.query(
      `
        delete from book_objects source_object
        where source_object.id = $1
          and not exists (select 1 from library_books where object_id = source_object.id)
      `,
      [plan.sourceObjectId],
    );
  }
  await saveAliases(client, plan, true);
  const activatedRows = await loadBookSnapshot(client, plan.userId, plan.canonicalBookId, true);
  const activatedReport = {
    ...plan.report,
    activatedStateHash: bookSnapshotStateHash(activatedRows),
  };
  await client.query(
    `
      update id_v2_migration_runs
      set status = 'activated',
          canonical_book_id = $2,
          source_fingerprint = $3::jsonb,
          report = $4::jsonb,
          error_code = null,
          activated_at = now(),
          finished_at = now(),
          updated_at = now()
      where id = $1
    `,
    [plan.runId, plan.canonicalBookId, JSON.stringify(plan.sourceFingerprint), JSON.stringify(activatedReport)],
  );
  await client.query(
    `
      insert into id_v2_migration_checkpoints (run_id, stage, cursor, completed)
      values ($1, 'activated', $2::jsonb, true)
      on conflict (run_id, stage) do update
      set cursor = excluded.cursor, completed = true, updated_at = now()
    `,
    [plan.runId, JSON.stringify({ canonicalBookId: plan.canonicalBookId })],
  );
  return activatedReport;
}
