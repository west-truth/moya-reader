import type { SyncEventRow } from './row-mappers.js';
import type { SyncQueryRunner } from './sync-contract-translation.js';

export async function querySyncEventsAfter(
  runner: SyncQueryRunner,
  userId: string,
  since: number,
): Promise<SyncEventRow[]> {
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
