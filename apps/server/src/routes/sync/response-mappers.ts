import { SYNC_CONTRACT_V2 } from '../../../../../src/sync/contract.js';
import type { PushSyncResult, RejectedSyncEvent, ResolvedSyncContract, SyncEvent } from '@noveldesk/contracts/sync';

function transportEvent(event: SyncEvent) {
  return {
    contractVersion: event.contractVersion,
    idContract: event.idContract,
    hashContract: event.hashContract,
    sequence: event.sequence,
    id: event.id,
    device_id: event.deviceId,
    type: event.type,
    book_id: event.novelId ?? null,
    entity_id: event.entityId ?? null,
    payload: event.payload,
    revision: event.revision ?? null,
    created_at: event.createdAt,
  };
}

export function mapPullSyncResponse(events: SyncEvent[], cursor: number, contract: ResolvedSyncContract) {
  return {
    ...contract,
    cursor,
    events: events.map(transportEvent),
  };
}

export function mapPushSyncResponse(
  accepted: number,
  acceptedIds: string[],
  rejected: RejectedSyncEvent[],
): PushSyncResult {
  const result: PushSyncResult = { ...SYNC_CONTRACT_V2, accepted, acceptedIds };
  if (rejected.length) result.rejected = rejected;
  return result;
}
