export type * from '@noveldesk/contracts/sync';

/** A bounded status-index sample for UI/guards; full replay and history queries omit this option. */
export interface SyncOutboxQueryOptions {
  readonly limit?: number;
}
