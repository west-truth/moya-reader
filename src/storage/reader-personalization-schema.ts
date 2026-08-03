export const READER_PERSONALIZATION_STORES = {
  fonts: 'user_fonts',
  sessions: 'reading_session_events',
} as const;

export function upgradeReaderPersonalizationStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(READER_PERSONALIZATION_STORES.fonts)) {
    const store = db.createObjectStore(READER_PERSONALIZATION_STORES.fonts, { keyPath: 'id' });
    store.createIndex('contentHash', 'contentHash', { unique: true });
    store.createIndex('updatedAt', 'updatedAt');
  }
  if (!db.objectStoreNames.contains(READER_PERSONALIZATION_STORES.sessions)) {
    const store = db.createObjectStore(READER_PERSONALIZATION_STORES.sessions, { keyPath: 'id' });
    store.createIndex('bookId', 'bookId');
    store.createIndex('endedAt', 'endedAt');
    store.createIndex('bookId_endedAt', ['bookId', 'endedAt']);
    store.createIndex('operationId', 'operationId', { unique: true });
  }
}
