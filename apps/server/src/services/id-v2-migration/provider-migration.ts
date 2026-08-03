import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  IdV2MigrationError,
  type IdV2IdentityFactory,
  type MigrationLogger,
  type MigrationRunStatus,
  type RollbackProviderOptions,
} from './contracts.js';
import {
  PROVIDER_BACKUP_TABLES,
  activeProviderJobCount,
  buildProviderMigrationPlan,
  loadProviderSourceRows,
  providerRowsNeedMigration,
  providerStateHash,
  type ProviderBackupTable,
  type ProviderMigrationPlan,
  type ProviderSourceRows,
} from './provider-state.js';
import { safeErrorCode, safeErrorDetails, type JsonRecord } from './safe-values.js';

interface RunRow extends pg.QueryResultRow {
  id: string;
  status: MigrationRunStatus;
  report: JsonRecord;
  activated_at: Date | string | null;
}

interface BackupRow extends pg.QueryResultRow {
  table_name: ProviderBackupTable;
  row_data: JsonRecord;
}

export interface ProviderIdentityMigrationResult {
  readonly runId: string;
  readonly userId: string;
  readonly status: MigrationRunStatus;
  readonly settingsMigrated: number;
  readonly secretsMigrated: number;
  readonly syncEventsMigrated: number;
  readonly report: Record<string, unknown>;
}

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

function resultFromReport(
  runId: string,
  userId: string,
  status: MigrationRunStatus,
  report: Record<string, unknown>,
): ProviderIdentityMigrationResult {
  return {
    runId,
    userId,
    status,
    settingsMigrated: Number(report.settingsMigrated ?? 0),
    secretsMigrated: Number(report.secretsMigrated ?? 0),
    syncEventsMigrated: Number(report.syncEventsMigrated ?? 0),
    report,
  };
}

async function latestActivatedRun(client: pg.PoolClient, userId: string): Promise<RunRow | undefined> {
  const result = await client.query<RunRow>(
    `select id, status, report, activated_at
     from id_v2_migration_runs
     where migration_kind = 'global_provider' and user_id = $1 and status = 'activated'
     order by activated_at desc, created_at desc limit 1`,
    [userId],
  );
  return result.rows[0];
}

async function ensureRun(client: pg.PoolClient, userId: string): Promise<RunRow> {
  const existing = await client.query<RunRow>(
    `select id, status, report, activated_at
     from id_v2_migration_runs
     where migration_kind = 'global_provider'
       and user_id = $1
       and status in ('pending', 'running', 'deferred', 'staged')
     order by created_at desc limit 1`,
    [userId],
  );
  if (existing.rows[0]) {
    await client.query(
      `update id_v2_migration_runs
       set status = 'running', error_code = null,
           started_at = coalesce(started_at, now()), updated_at = now()
       where id = $1`,
      [existing.rows[0].id],
    );
    return { ...existing.rows[0], status: 'running' };
  }

  const inserted = await client.query<RunRow>(
    `insert into id_v2_migration_runs (
       id, migration_kind, user_id, status, started_at
     ) values ($1, 'global_provider', $2, 'running', now())
     returning id, status, report, activated_at`,
    [randomUUID(), userId],
  );
  return inserted.rows[0];
}

async function saveAliases(
  client: pg.PoolClient,
  runId: string,
  userId: string,
  plan: ProviderMigrationPlan,
  complete: boolean,
): Promise<void> {
  await client.query(`delete from id_v2_global_aliases where run_id = $1 and alias_complete = false`, [runId]);
  if (plan.aliases.length === 0) return;
  await client.query(
    `insert into id_v2_global_aliases (
       user_id, entity_type, source_id, canonical_id, run_id, status, alias_complete
     )
     select $1, alias."entityType", alias."sourceId", alias."canonicalId", $2, 'active', $3
     from jsonb_to_recordset($4::jsonb) as alias(
       "entityType" text, "sourceId" text, "canonicalId" text
     )
     on conflict (user_id, entity_type, source_id) do update
     set canonical_id = excluded.canonical_id,
         run_id = excluded.run_id,
         status = 'active',
         alias_complete = excluded.alias_complete,
         updated_at = now()`,
    [userId, runId, complete, JSON.stringify(plan.aliases)],
  );
}

async function stagePlan(
  client: pg.PoolClient,
  run: RunRow,
  userId: string,
  plan: ProviderMigrationPlan,
): Promise<void> {
  await saveAliases(client, run.id, userId, plan, false);
  await client.query(
    `insert into id_v2_migration_checkpoints (run_id, stage, cursor, completed)
     values ($1, 'provider_planned', $2::jsonb, true)
     on conflict (run_id, stage) do update
     set cursor = excluded.cursor, completed = true, updated_at = now()`,
    [run.id, JSON.stringify({ sourceStateHash: plan.sourceStateHash, ...plan.report })],
  );
  await client.query(
    `update id_v2_migration_runs
     set status = 'staged', source_fingerprint = $2::jsonb,
         report = $3::jsonb, error_code = null, updated_at = now()
     where id = $1`,
    [run.id, JSON.stringify({ stateHash: plan.sourceStateHash }), JSON.stringify(plan.report)],
  );
}

async function markDeferred(
  client: pg.PoolClient,
  runId: string,
  userId: string,
  activeJobs: number,
): Promise<ProviderIdentityMigrationResult> {
  const report = { activeWork: { providerJobs: activeJobs }, retryable: true };
  await client.query(
    `update id_v2_migration_runs
     set status = 'deferred', report = $2::jsonb,
         error_code = 'provider_work_active', updated_at = now()
     where id = $1`,
    [runId, JSON.stringify(report)],
  );
  return resultFromReport(runId, userId, 'deferred', report);
}

async function saveBackups(client: pg.PoolClient, runId: string, rows: ProviderSourceRows): Promise<void> {
  for (const [restoreOrder, table] of PROVIDER_BACKUP_TABLES.entries()) {
    if (rows[table].length === 0) continue;
    await client.query(
      `insert into id_v2_migration_backups (
         run_id, table_name, source_key, restore_order, row_data
       )
       select $1, $2, backup.row_data->>'id', $3, backup.row_data
       from jsonb_array_elements($4::jsonb) backup(row_data)
       on conflict (run_id, table_name, source_key) do nothing`,
      [runId, table, restoreOrder, JSON.stringify(rows[table])],
    );
  }
}

async function assertNoTargetCollision(client: pg.PoolClient, plan: ProviderMigrationPlan): Promise<void> {
  for (const table of PROVIDER_BACKUP_TABLES) {
    const sourceIds = new Set(plan.sourceRows[table].map((row) => String(row.id)));
    const canonicalIds = plan.targetRows[table].map((row) => String(row.id));
    if (canonicalIds.length === 0) continue;
    const existing = await client.query<{ id: string }>(`select id from ${table} where id = any($1::text[])`, [
      canonicalIds,
    ]);
    const collision = existing.rows.find((row) => !sourceIds.has(row.id));
    if (collision) {
      throw new IdV2MigrationError('provider_identity_collision', 'A canonical provider identity is occupied.', {
        entityType: table,
        sourceId: collision.id,
      });
    }
  }
}

async function insertRows(
  client: pg.PoolClient,
  table: ProviderBackupTable,
  rows: readonly JsonRecord[],
): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `insert into ${table}
     select populated.* from jsonb_populate_recordset(null::${table}, $1::jsonb) populated`,
    [JSON.stringify(rows)],
  );
}

async function replaceProviderState(client: pg.PoolClient, userId: string, rows: ProviderSourceRows): Promise<void> {
  await client.query('delete from provider_settings where user_id = $1', [userId]);
  await client.query('delete from provider_secrets where user_id = $1', [userId]);
  await client.query('delete from sync_events where user_id = $1 and book_id is null', [userId]);
  for (const table of PROVIDER_BACKUP_TABLES) await insertRows(client, table, rows[table]);
}

async function cutoverProviderState(
  client: pg.PoolClient,
  run: RunRow,
  userId: string,
  plan: ProviderMigrationPlan,
): Promise<Record<string, unknown>> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 764173))', [userId]);
  await client.query('lock table provider_settings, provider_secrets, sync_events in share row exclusive mode');
  const currentRows = await loadProviderSourceRows(client, userId, true);
  const activeJobs = await activeProviderJobCount(client, userId);
  if (activeJobs > 0) {
    throw new IdV2MigrationError('provider_work_active', 'Provider work is active.', {
      activeWork: { providerJobs: activeJobs },
    });
  }
  if (providerStateHash(currentRows) !== plan.sourceStateHash) {
    throw new IdV2MigrationError('provider_source_changed', 'Provider state changed after planning.');
  }
  await assertNoTargetCollision(client, plan);
  await saveBackups(client, run.id, currentRows);
  await replaceProviderState(client, userId, plan.targetRows);
  await saveAliases(client, run.id, userId, plan, true);

  const activatedRows = await loadProviderSourceRows(client, userId, true);
  const report = { ...plan.report, activatedStateHash: providerStateHash(activatedRows) };
  await client.query(
    `update id_v2_migration_runs
     set status = 'activated', report = $2::jsonb, error_code = null,
         activated_at = now(), finished_at = now(), updated_at = now()
     where id = $1`,
    [run.id, JSON.stringify(report)],
  );
  await client.query(
    `insert into id_v2_migration_checkpoints (run_id, stage, cursor, completed)
     values ($1, 'provider_activated', $2::jsonb, true)
     on conflict (run_id, stage) do update
     set cursor = excluded.cursor, completed = true, updated_at = now()`,
    [run.id, JSON.stringify({ activatedStateHash: report.activatedStateHash })],
  );
  return report;
}

async function recordFailure(
  client: pg.PoolClient,
  run: RunRow,
  userId: string,
  error: unknown,
  plan?: ProviderMigrationPlan,
): Promise<ProviderIdentityMigrationResult> {
  const sourceCode = safeErrorCode(error);
  const quarantined = sourceCode === 'provider_identity_collision';
  const code = quarantined
    ? sourceCode
    : sourceCode === 'provider_source_changed'
      ? sourceCode
      : 'provider_migration_failed';
  const status: MigrationRunStatus = quarantined ? 'quarantined' : 'failed';
  const details = safeErrorDetails(error);
  const report = { ...plan?.report, errorCode: code, ...details };
  await transaction(client, async () => {
    if (quarantined) {
      await client.query(
        `update id_v2_global_aliases
         set status = 'quarantined', alias_complete = false, updated_at = now()
         where run_id = $1`,
        [run.id],
      );
      const entries = plan?.aliases.length
        ? plan.aliases
        : [{ entityType: 'provider_settings', sourceId: String(details.sourceId ?? '') }];
      for (const entry of entries) {
        await client.query(
          `insert into id_v2_migration_quarantine (
             run_id, user_id, source_book_id, entity_type, source_id, reason_code, safe_details
           ) values ($1, $2, null, $3, $4, $5, $6::jsonb)`,
          [run.id, userId, entry.entityType, entry.sourceId || null, code, JSON.stringify(details)],
        );
      }
    }
    await client.query(
      `update id_v2_migration_runs
       set status = $2, error_code = $3, report = $4::jsonb,
           finished_at = now(), updated_at = now()
       where id = $1`,
      [run.id, status, code, JSON.stringify(report)],
    );
  });
  return resultFromReport(run.id, userId, status, report);
}

export async function migrateProviderIdentities(input: {
  readonly pool: pg.Pool;
  readonly identities: IdV2IdentityFactory;
  readonly userId: string;
  readonly logger?: MigrationLogger;
  readonly stopAfterStage?: boolean;
}): Promise<ProviderIdentityMigrationResult> {
  const client = await input.pool.connect();
  const lockKey = `id-v2-provider:${input.userId}`;
  let locked = false;
  let run: RunRow | undefined;
  let plan: ProviderMigrationPlan | undefined;
  try {
    await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    locked = true;
    const sourceRows = await loadProviderSourceRows(client, input.userId);
    if (!providerRowsNeedMigration(sourceRows)) {
      const activated = await latestActivatedRun(client, input.userId);
      if (activated) return resultFromReport(activated.id, input.userId, 'activated', activated.report);
    }

    run = await ensureRun(client, input.userId);
    const activeJobs = await activeProviderJobCount(client, input.userId);
    if (activeJobs > 0) return await markDeferred(client, run.id, input.userId, activeJobs);

    plan = buildProviderMigrationPlan(sourceRows, input.identities);
    await transaction(client, () => stagePlan(client, run!, input.userId, plan!));
    if (input.stopAfterStage) return resultFromReport(run.id, input.userId, 'staged', plan.report);

    const report = await transaction(client, () => cutoverProviderState(client, run!, input.userId, plan!));
    input.logger?.info('ID v2 provider identity migration activated.');
    return resultFromReport(run.id, input.userId, 'activated', report);
  } catch (error) {
    if (!run) throw error;
    if (safeErrorCode(error) === 'provider_work_active') {
      return await markDeferred(client, run.id, input.userId, await activeProviderJobCount(client, input.userId));
    }
    const result = await recordFailure(client, run, input.userId, error, plan);
    input.logger?.warn(`ID v2 provider identity migration stopped: ${String(result.report.errorCode)}.`);
    return result;
  } finally {
    if (locked) {
      await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => undefined);
    }
    client.release();
  }
}

async function loadProviderBackups(client: pg.PoolClient, runId: string): Promise<ProviderSourceRows> {
  const result = await client.query<BackupRow>(
    `select table_name, row_data from id_v2_migration_backups
     where run_id = $1 and table_name = any($2::text[])
     order by restore_order, table_name, source_key`,
    [runId, PROVIDER_BACKUP_TABLES],
  );
  const rows: ProviderSourceRows = { provider_settings: [], provider_secrets: [], sync_events: [] };
  for (const backup of result.rows) rows[backup.table_name].push(backup.row_data);
  return rows;
}

export async function rollbackProviderIdentities(input: {
  readonly pool: pg.Pool;
  readonly options: RollbackProviderOptions;
  readonly logger?: MigrationLogger;
}): Promise<ProviderIdentityMigrationResult> {
  const { userId } = input.options;
  const client = await input.pool.connect();
  const lockKey = `id-v2-provider:${userId}`;
  let locked = false;
  try {
    await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    locked = true;
    const run = await latestActivatedRun(client, userId);
    if (!run)
      throw new IdV2MigrationError('provider_rollback_unavailable', 'No provider migration can be rolled back.');
    const report = await transaction(client, async () => {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 764173))', [userId]);
      await client.query('lock table provider_settings, provider_secrets, sync_events in share row exclusive mode');
      const activeJobs = await activeProviderJobCount(client, userId);
      if (activeJobs > 0) {
        throw new IdV2MigrationError('provider_work_active', 'Provider work is active.', {
          activeWork: { providerJobs: activeJobs },
        });
      }
      const currentRows = await loadProviderSourceRows(client, userId, true);
      if (
        typeof run.report.activatedStateHash !== 'string' ||
        providerStateHash(currentRows) !== run.report.activatedStateHash
      ) {
        throw new IdV2MigrationError(
          'provider_rollback_requires_forward_recovery',
          'Provider state changed after cutover; recover forward instead.',
        );
      }
      const backups = await loadProviderBackups(client, run.id);
      const backupCount = PROVIDER_BACKUP_TABLES.reduce((count, table) => count + backups[table].length, 0);
      const expectedCount = Number(run.report.aliasCount ?? 0);
      if (backupCount !== expectedCount) {
        throw new IdV2MigrationError('provider_rollback_backup_missing', 'Provider rollback material is incomplete.');
      }
      await replaceProviderState(client, userId, backups);
      await client.query(
        `update id_v2_global_aliases
         set status = 'rolled_back', alias_complete = false, updated_at = now()
         where run_id = $1`,
        [run.id],
      );
      const rollbackReport = { ...run.report, rollback: 'completed' };
      await client.query(
        `update id_v2_migration_runs
         set status = 'rolled_back', report = $2::jsonb,
             finished_at = now(), updated_at = now()
         where id = $1`,
        [run.id, JSON.stringify(rollbackReport)],
      );
      return rollbackReport;
    });
    input.logger?.info('ID v2 provider identity migration rolled back.');
    return resultFromReport(run.id, userId, 'rolled_back', report);
  } finally {
    if (locked) {
      await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => undefined);
    }
    client.release();
  }
}
