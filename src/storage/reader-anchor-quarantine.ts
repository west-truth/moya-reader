export const READER_ANCHOR_QUARANTINE_STORE = 'reader_anchor_quarantine' as const;

export type ReaderAnchorQuarantineEntity = 'reading_position' | 'bookmark' | 'highlight' | 'note' | 'sync_outbox';

export interface ReaderAnchorQuarantineRecord {
  readonly id: string;
  readonly novelId: string;
  readonly entityType: ReaderAnchorQuarantineEntity;
  readonly sourceEntityId: string;
  readonly sourceContentRevisionId?: string;
  readonly targetContentRevisionId?: string;
  readonly reason: 'content_replaced_anchor_unmatched' | 'content_replaced_inflight_replaced';
  readonly payload: unknown;
  readonly quarantinedAt: string;
}

export function upgradeReaderAnchorQuarantineStore(db: IDBDatabase): void {
  if (db.objectStoreNames.contains(READER_ANCHOR_QUARANTINE_STORE)) return;
  const store = db.createObjectStore(READER_ANCHOR_QUARANTINE_STORE, { keyPath: 'id' });
  store.createIndex('novelId', 'novelId');
  store.createIndex('entityType', 'entityType');
  store.createIndex('targetContentRevisionId', 'targetContentRevisionId');
  store.createIndex('quarantinedAt', 'quarantinedAt');
}
