import { parseSyncContractFields } from '../../../../../src/sync/contract.js';
import type { ResolvedSyncContract, SyncContractFields, SyncEvent } from '@noveldesk/contracts/sync';

export interface PullSyncQuery {
  since?: string;
  contractVersion?: string;
  idContract?: string;
  hashContract?: string;
}

export interface PushEventsBody extends SyncContractFields {
  events?: SyncEvent[];
}

export function parseSyncCursor(value: string | undefined): number {
  return Math.max(0, Number.parseInt(value ?? '0', 10) || 0);
}

export function pullSyncContract(query: PullSyncQuery): ResolvedSyncContract {
  return parseSyncContractFields(query);
}

export function pushSyncContract(body: PushEventsBody | undefined): ResolvedSyncContract {
  return parseSyncContractFields(body ?? {});
}
