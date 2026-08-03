import { SYNC_CONTRACT_V1, SYNC_CONTRACT_V2 } from '../../../../../src/sync/contract.js';
import type { JsonValue, SyncEvent } from '@noveldesk/contracts/sync';

export interface SyncEventRow {
  sequence: number | string;
  id: string;
  device_id: string;
  type: SyncEvent['type'];
  book_id: string | null;
  entity_id: string | null;
  payload: unknown;
  revision: unknown | null;
  created_at: string | Date;
  id_contract?: string | null;
  hash_contract?: string | null;
  source_contract_version?: number | string | null;
  source_event_id?: string | null;
}

export function mapSyncEventRow(row: SyncEventRow): SyncEvent {
  const contract =
    row.id_contract === SYNC_CONTRACT_V2.idContract && row.hash_contract === SYNC_CONTRACT_V2.hashContract
      ? SYNC_CONTRACT_V2
      : SYNC_CONTRACT_V1;
  return {
    ...contract,
    sequence: Number(row.sequence),
    id: row.id,
    deviceId: row.device_id || 'server',
    type: row.type,
    novelId: row.book_id ?? undefined,
    entityId: row.entity_id ?? undefined,
    payload: row.payload as JsonValue,
    revision: row.revision as SyncEvent['revision'],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}
