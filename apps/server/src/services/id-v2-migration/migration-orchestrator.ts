import type pg from 'pg';
import { HASH_V2_CONTRACT, ID_V2_CONTRACT, IdV2MigrationError } from './contracts.js';

interface CountRow extends pg.QueryResultRow {
  legacy_books: string | number;
  legacy_provider_settings: string | number;
  legacy_provider_secrets: string | number;
  legacy_sync_events: string | number;
  incomplete_runs: string | number;
  quarantined_runs: string | number;
  failed_runs: string | number;
}

export interface IdentityMigrationStatus {
  readonly contractStatus: 'expanded' | 'active';
  readonly legacyBooks: number;
  readonly legacyProviderSettings: number;
  readonly legacyProviderSecrets: number;
  readonly legacySyncEvents: number;
  readonly incompleteRuns: number;
  readonly quarantinedRuns: number;
  readonly failedRuns: number;
}

export interface BookMigrationCandidate {
  readonly userId: string;
  readonly sourceBookId: string;
}

export async function assertIdV2SchemaReady(pool: pg.Pool): Promise<void> {
  try {
    const result = await pool.query<{ status: string }>(
      `select status from identity_contract_metadata where contract_name = 'persistent_identity'`,
    );
    if (!result.rows[0]) throw new Error('metadata_missing');
  } catch {
    throw new IdV2MigrationError(
      'id_v2_schema_not_expanded',
      'Database migration 0004 must be applied before the ID v2 backfill.',
    );
  }
}

export async function listMigrationUserIds(pool: pg.Pool, requestedUserId?: string): Promise<string[]> {
  if (requestedUserId) {
    const user = await pool.query<{ id: string }>('select id from users where id = $1', [requestedUserId]);
    if (!user.rows[0]) throw new IdV2MigrationError('migration_user_not_found', 'The migration user does not exist.');
    return [requestedUserId];
  }
  const result = await pool.query<{ id: string }>(
    `select user_row.id
     from users user_row
     where exists (
       select 1 from library_books book
       where book.user_id = user_row.id
         and (book.id_contract <> $1 or book.hash_contract <> $2)
     ) or exists (
       select 1 from provider_settings settings
       where settings.user_id = user_row.id and settings.id_contract <> $1
     ) or exists (
       select 1 from provider_secrets secret
       where secret.user_id = user_row.id and secret.id_contract <> $1
     ) or exists (
       select 1 from sync_events event
       where event.user_id = user_row.id
         and (event.id_contract <> $1 or event.hash_contract <> $2)
     )
     order by user_row.id`,
    [ID_V2_CONTRACT, HASH_V2_CONTRACT],
  );
  return result.rows.map((row) => row.id);
}

export async function listBookMigrationCandidates(
  pool: pg.Pool,
  input: {
    readonly userId: string;
    readonly sourceBookId?: string;
    readonly limit?: number;
    readonly retryQuarantined?: boolean;
  },
): Promise<BookMigrationCandidate[]> {
  const limit = input.limit ?? 1_000;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new IdV2MigrationError('migration_limit_invalid', 'The migration limit must be a positive integer.');
  }
  const result = await pool.query<{ user_id: string; id: string }>(
    `select book.user_id, book.id
     from library_books book
     where book.user_id = $1
       and ($2::text is null or book.id = $2)
       and (
         book.id_contract <> $3
         or book.hash_contract <> $4
         or exists (
           select 1 from sync_events event
           where event.user_id = book.user_id
             and event.book_id = book.id
             and (event.id_contract <> $3 or event.hash_contract <> $4)
         )
       )
       and (
         $5::boolean
         or not exists (
           select 1 from id_v2_book_aliases alias_row
           where alias_row.user_id = book.user_id
             and alias_row.source_book_id = book.id
             and alias_row.status = 'quarantined'
         )
       )
     order by book.created_at, book.id
     limit $6`,
    [
      input.userId,
      input.sourceBookId ?? null,
      ID_V2_CONTRACT,
      HASH_V2_CONTRACT,
      input.retryQuarantined ?? false,
      limit,
    ],
  );
  if (input.sourceBookId && result.rows.length === 0) {
    const book = await pool.query<{ id_contract: string; hash_contract: string }>(
      `select id_contract, hash_contract from library_books where user_id = $1 and id = $2`,
      [input.userId, input.sourceBookId],
    );
    if (!book.rows[0]) throw new IdV2MigrationError('book_not_found', 'The source book does not exist.');
    if (book.rows[0].id_contract === ID_V2_CONTRACT && book.rows[0].hash_contract === HASH_V2_CONTRACT) return [];
    throw new IdV2MigrationError(
      'book_quarantined',
      'The source book is quarantined; use the explicit retry option after correcting the cause.',
    );
  }
  return result.rows.map((row) => ({ userId: row.user_id, sourceBookId: row.id }));
}

async function countMigrationState(pool: pg.Pool): Promise<CountRow> {
  const result = await pool.query<CountRow>(
    `select
       (select count(*) from library_books where id_contract <> $1 or hash_contract <> $2) as legacy_books,
       (select count(*) from provider_settings where id_contract <> $1) as legacy_provider_settings,
       (select count(*) from provider_secrets where id_contract <> $1) as legacy_provider_secrets,
       (select count(*) from sync_events where id_contract <> $1 or hash_contract <> $2) as legacy_sync_events,
       (select count(*) from id_v2_migration_runs
        where status in ('pending', 'running', 'deferred', 'staged')) as incomplete_runs,
       (select count(*) from id_v2_migration_runs where status = 'quarantined') as quarantined_runs,
       (select count(*) from id_v2_migration_runs where status = 'failed') as failed_runs`,
    [ID_V2_CONTRACT, HASH_V2_CONTRACT],
  );
  return result.rows[0];
}

export async function refreshIdentityContractStatus(pool: pg.Pool): Promise<IdentityMigrationStatus> {
  await assertIdV2SchemaReady(pool);
  const counts = await countMigrationState(pool);
  const complete =
    Number(counts.legacy_books) === 0 &&
    Number(counts.legacy_provider_settings) === 0 &&
    Number(counts.legacy_provider_secrets) === 0 &&
    Number(counts.legacy_sync_events) === 0 &&
    Number(counts.incomplete_runs) === 0;
  const contractStatus = complete ? 'active' : 'expanded';
  await pool.query(
    `update identity_contract_metadata
     set status = $1,
         activated_at = case when $1 = 'active' then coalesce(activated_at, now()) else null end,
         updated_at = now()
     where contract_name = 'persistent_identity'`,
    [contractStatus],
  );
  return {
    contractStatus,
    legacyBooks: Number(counts.legacy_books),
    legacyProviderSettings: Number(counts.legacy_provider_settings),
    legacyProviderSecrets: Number(counts.legacy_provider_secrets),
    legacySyncEvents: Number(counts.legacy_sync_events),
    incompleteRuns: Number(counts.incomplete_runs),
    quarantinedRuns: Number(counts.quarantined_runs),
    failedRuns: Number(counts.failed_runs),
  };
}

export async function readIdentityMigrationStatus(pool: pg.Pool): Promise<IdentityMigrationStatus> {
  await assertIdV2SchemaReady(pool);
  const [counts, metadata] = await Promise.all([
    countMigrationState(pool),
    pool.query<{ status: 'expanded' | 'active' }>(
      `select status from identity_contract_metadata where contract_name = 'persistent_identity'`,
    ),
  ]);
  return {
    contractStatus: metadata.rows[0]?.status ?? 'expanded',
    legacyBooks: Number(counts.legacy_books),
    legacyProviderSettings: Number(counts.legacy_provider_settings),
    legacyProviderSecrets: Number(counts.legacy_provider_secrets),
    legacySyncEvents: Number(counts.legacy_sync_events),
    incompleteRuns: Number(counts.incomplete_runs),
    quarantinedRuns: Number(counts.quarantined_runs),
    failedRuns: Number(counts.failed_runs),
  };
}

export async function markIdentityContractExpanded(pool: pg.Pool): Promise<void> {
  await assertIdV2SchemaReady(pool);
  await pool.query(
    `update identity_contract_metadata
     set status = 'expanded', activated_at = null, updated_at = now()
     where contract_name = 'persistent_identity'`,
  );
}
