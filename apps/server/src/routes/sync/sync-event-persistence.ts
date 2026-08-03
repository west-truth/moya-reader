import pg from 'pg';
import { SYNC_CONTRACT_V2 } from '../../../../../src/sync/contract.js';
import type { ResolvedSyncContract } from '@noveldesk/contracts/sync';
import type { SyncEvent } from '@noveldesk/contracts/sync';

export async function insertSyncEvent(
  client: pg.PoolClient,
  userId: string,
  event: SyncEvent,
  source: { eventId: string; contract: ResolvedSyncContract },
): Promise<boolean> {
  const inserted = await client.query(
    `
      insert into sync_events (
        id, user_id, device_id, type, book_id, entity_id, payload, revision, created_at,
        id_contract, hash_contract, source_contract_version, source_event_id
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      on conflict (id) do nothing
      returning id
    `,
    [
      event.id,
      userId,
      event.deviceId,
      event.type,
      event.novelId,
      event.entityId,
      JSON.stringify(event.payload),
      event.revision ? JSON.stringify(event.revision) : null,
      event.createdAt,
      SYNC_CONTRACT_V2.idContract,
      SYNC_CONTRACT_V2.hashContract,
      source.contract.contractVersion,
      source.contract.contractVersion === 1 ? source.eventId : null,
    ],
  );
  return (inserted.rowCount ?? 0) > 0;
}
