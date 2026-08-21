export const READER_PAGE_MAP_STORE = 'reader_page_maps' as const;

export function upgradeReaderPageMapStore(db: IDBDatabase): void {
  if (db.objectStoreNames.contains(READER_PAGE_MAP_STORE)) return;
  const store = db.createObjectStore(READER_PAGE_MAP_STORE, { keyPath: 'id' });
  store.createIndex('chapterId', 'chapterId');
  store.createIndex('lastAccessedAt', 'lastAccessedAt');
}
