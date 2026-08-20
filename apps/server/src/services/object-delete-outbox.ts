import pg from 'pg';
import type { ServerConfig } from '../config.js';
import { createS3Client, deleteObject } from './object-storage.js';

interface DeleteOutboxRow {
  id: string;
  storage_key: string;
  attempts: number;
}

function normalizedStorageKeys(storageKeys: Iterable<string>): string[] {
  return [...new Set([...storageKeys].map((key) => key.trim()).filter(Boolean))];
}

export async function enqueueObjectDeletions(
  queryable: Pick<pg.Pool, 'query'> | pg.PoolClient,
  storageKeys: Iterable<string>,
  reason: string,
): Promise<number> {
  const keys = normalizedStorageKeys(storageKeys);
  if (!keys.length) return 0;
  const result = await queryable.query(
    `insert into object_delete_outbox (storage_key, reason)
       select key, $2 from unnest($1::text[]) as keys(key)
     on conflict (storage_key) do update
       set reason = excluded.reason,
           status = case when object_delete_outbox.status = 'processing' then 'processing' else 'pending' end,
           next_attempt_at = least(object_delete_outbox.next_attempt_at, now()),
           updated_at = now()`,
    [keys, reason],
  );
  return result.rowCount ?? keys.length;
}

/**
 * Crash-safe reservation for an object that is about to be uploaded. The delay prevents a live operation from
 * racing its own cleanup; a crashed process leaves a durable orphan candidate behind.
 */
export async function reserveObjectDeletions(
  queryable: Pick<pg.Pool, 'query'> | pg.PoolClient,
  storageKeys: Iterable<string>,
  reason: string,
  delayMs = 24 * 60 * 60 * 1_000,
): Promise<number> {
  const keys = normalizedStorageKeys(storageKeys);
  if (!keys.length) return 0;
  const safeDelayMs = Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1_000, Math.floor(delayMs)));
  const result = await queryable.query(
    `insert into object_delete_outbox (storage_key, reason, status, next_attempt_at)
       select key, $2, 'pending', now() + ($3::bigint * interval '1 millisecond')
         from unnest($1::text[]) as keys(key)
     on conflict (storage_key) do update
       set reason = excluded.reason,
           next_attempt_at = least(object_delete_outbox.next_attempt_at, excluded.next_attempt_at),
           updated_at = now()`,
    [keys, reason, safeDelayMs],
  );
  return result.rowCount ?? keys.length;
}

/** Remove successful staging reservations in the same transaction that publishes their durable DB references. */
export async function releaseObjectDeletionReservations(
  queryable: Pick<pg.Pool, 'query'> | pg.PoolClient,
  storageKeys: Iterable<string>,
): Promise<number> {
  const keys = normalizedStorageKeys(storageKeys);
  if (!keys.length) return 0;
  const result = await queryable.query(
    `delete from object_delete_outbox
      where storage_key = any($1::text[]) and status <> 'processing'`,
    [keys],
  );
  return result.rowCount ?? 0;
}

async function claimObjectDeletions(pool: pg.Pool, limit: number): Promise<DeleteOutboxRow[]> {
  const result = await pool.query<DeleteOutboxRow>(
    `with candidates as (
       select id
       from object_delete_outbox
       where (
         status in ('pending', 'retry') and next_attempt_at <= now()
       ) or (
         status = 'processing' and updated_at < now() - interval '10 minutes'
       )
       order by id
       for update skip locked
       limit $1
     )
     update object_delete_outbox target
        set status = 'processing', attempts = attempts + 1, updated_at = now()
       from candidates
      where target.id = candidates.id
     returning target.id::text, target.storage_key, target.attempts`,
    [Math.max(1, Math.min(100, Math.floor(limit)))],
  );
  return result.rows;
}

export async function drainObjectDeleteOutbox(
  pool: pg.Pool,
  config: ServerConfig,
  limit = 25,
  dependencies: { deleteStoredObject?: (storageKey: string) => Promise<void> } = {},
): Promise<{ deleted: number; failed: number }> {
  const rows = await claimObjectDeletions(pool, limit);
  if (!rows.length) return { deleted: 0, failed: 0 };
  const s3 = dependencies.deleteStoredObject ? undefined : createS3Client(config);
  const remove = dependencies.deleteStoredObject ?? ((storageKey: string) => deleteObject(s3!, config, storageKey));
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const referenced = await pool.query(
        `select 1 where
           exists (select 1 from book_objects where storage_key = $1)
           or exists (select 1 from book_assets where storage_key = $1)
           or exists (select 1 from user_fonts where storage_key = $1)
           or exists (select 1 from tts_audio_cache where audio_object_key = $1)
           or exists (select 1 from analysis_review_artifacts where raw_response_object_key = $1)`,
        [row.storage_key],
      );
      if (referenced.rows.length > 0) {
        await pool.query('delete from object_delete_outbox where id = $1 and status = $2', [row.id, 'processing']);
        continue;
      }
      await remove(row.storage_key);
      await pool.query('delete from object_delete_outbox where id = $1 and status = $2', [row.id, 'processing']);
      deleted += 1;
    } catch (error) {
      const retrySeconds = Math.min(3_600, 2 ** Math.min(10, Math.max(1, Number(row.attempts))));
      await pool.query(
        `update object_delete_outbox
            set status = 'retry',
                next_attempt_at = now() + ($2::integer * interval '1 second'),
                last_error = $3,
                updated_at = now()
          where id = $1 and status = 'processing'`,
        [row.id, retrySeconds, error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000)],
      );
      failed += 1;
    }
  }
  return { deleted, failed };
}
