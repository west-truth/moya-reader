import type { SyncEventRow } from './row-mappers.js';
import type { SyncQueryRunner } from './sync-contract-translation.js';

/** Call inside a READ COMMITTED transaction, before taking the SELECT snapshot.
 * Sequence allocation precedes commit. Without this boundary, a later committed
 * sequence can advance the cursor past an earlier, still uncommitted event.
 * SHARE permits concurrent pulls; its short lock timeout makes busy writers retryable.
 */
export async function waitForSyncWriters(runner: SyncQueryRunner): Promise<void> {
  await runner.query("set local lock_timeout = '2s'");
  await runner.query('lock table sync_events in share mode');
}

export async function querySyncEventsAfter(
  runner: SyncQueryRunner,
  userId: string,
  since: number,
): Promise<SyncEventRow[]> {
  await waitForSyncWriters(runner);
  const result = await runner.query<SyncEventRow>(
    `
      select sequence, id, device_id, type, book_id, entity_id, payload, revision, created_at,
             id_contract, hash_contract, source_contract_version, source_event_id
      from sync_events
      where user_id = $1 and sequence > $2
      order by sequence asc
      limit 500
    `,
    [userId, since],
  );
  return result.rows;
}
