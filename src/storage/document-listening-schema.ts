export const DOCUMENT_LISTENING_STORES = {
  listeningPositions: 'listening_positions',
  ttsDownloadJobs: 'tts_download_jobs',
  ttsDownloadItems: 'tts_download_items',
  ttsOfflineCacheManifest: 'tts_offline_cache_manifest',
  ttsOfflineCacheBlobs: 'tts_offline_cache_blobs',
  documentPages: 'document_pages',
  documentThumbnailCache: 'document_thumbnail_cache',
  documentTextRevisions: 'document_text_revisions',
  documentTextBlocks: 'document_text_blocks',
  documentTextOrderOverrides: 'document_text_order_overrides',
  documentSearchTerms: 'document_search_terms',
  documentAnnotations: 'document_annotations',
  comicProfiles: 'comic_profiles',
  spokenTextRules: 'spoken_text_rules',
} as const;

function createStore(db: IDBDatabase, name: string): IDBObjectStore {
  return db.createObjectStore(name, { keyPath: 'id' });
}

export function upgradeDocumentListeningStores(db: IDBDatabase, transaction: IDBTransaction): void {
  if (!db.objectStoreNames.contains(DOCUMENT_LISTENING_STORES.listeningPositions)) {
    const store = createStore(db, DOCUMENT_LISTENING_STORES.listeningPositions);
    store.createIndex('bookId', 'bookId', { unique: true });
    store.createIndex('updatedAt', 'updatedAt');
  }
  if (!db.objectStoreNames.contains(DOCUMENT_LISTENING_STORES.ttsDownloadJobs)) {
    const store = createStore(db, DOCUMENT_LISTENING_STORES.ttsDownloadJobs);
    store.createIndex('bookId', 'bookId');
    store.createIndex('state', 'state');
    store.createIndex('updatedAt', 'updatedAt');
  }
  if (!db.objectStoreNames.contains(DOCUMENT_LISTENING_STORES.ttsDownloadItems)) {
    const store = createStore(db, DOCUMENT_LISTENING_STORES.ttsDownloadItems);
    store.createIndex('jobId', 'jobId');
    store.createIndex('bookId', 'bookId');
    store.createIndex('cacheKey', 'cacheKey');
    store.createIndex('state', 'state');
  }
  if (!db.objectStoreNames.contains(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest)) {
    const store = createStore(db, DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest);
    store.createIndex('bookId', 'bookId');
    store.createIndex('cacheKey', 'cacheKey', { unique: true });
    store.createIndex('lastAccessedAt', 'lastAccessedAt');
  }
  const cacheManifest = transaction.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest);
  if (!cacheManifest.indexNames.contains('bookId_renderSpecHash_storage')) {
    cacheManifest.createIndex('bookId_renderSpecHash_storage', ['bookId', 'renderSpecHash', 'storage']);
  }
  if (!db.objectStoreNames.contains(DOCUMENT_LISTENING_STORES.ttsOfflineCacheBlobs)) {
    const store = createStore(db, DOCUMENT_LISTENING_STORES.ttsOfflineCacheBlobs);
    store.createIndex('bookId', 'bookId');
  }
  if (!db.objectStoreNames.contains(DOCUMENT_LISTENING_STORES.documentPages)) {
    const store = createStore(db, DOCUMENT_LISTENING_STORES.documentPages);
    store.createIndex('bookId', 'bookId');
    store.createIndex('bookId_pageIndex', ['bookId', 'pageIndex'], { unique: true });
    store.createIndex('pageHash', 'pageHash');
  }
  if (!db.objectStoreNames.contains(DOCUMENT_LISTENING_STORES.documentThumbnailCache)) {
    const store = createStore(db, DOCUMENT_LISTENING_STORES.documentThumbnailCache);
    store.createIndex('bookId', 'bookId');
    store.createIndex('lastAccessedAt', 'lastAccessedAt');
  }
  if (!db.objectStoreNames.contains(DOCUMENT_LISTENING_STORES.documentTextRevisions)) {
    const store = createStore(db, DOCUMENT_LISTENING_STORES.documentTextRevisions);
    store.createIndex('bookId', 'bookId');
    store.createIndex('bookId_pageIndex', ['bookId', 'pageIndex']);
    store.createIndex('pageHash', 'pageHash');
    store.createIndex('status', 'status');
  }
  if (!db.objectStoreNames.contains(DOCUMENT_LISTENING_STORES.documentTextBlocks)) {
    const store = createStore(db, DOCUMENT_LISTENING_STORES.documentTextBlocks);
    store.createIndex('bookId', 'bookId');
    store.createIndex('revisionId', 'revisionId');
    store.createIndex('revisionId_order', ['revisionId', 'order'], { unique: true });
  }
  if (!db.objectStoreNames.contains(DOCUMENT_LISTENING_STORES.documentTextOrderOverrides)) {
    const store = createStore(db, DOCUMENT_LISTENING_STORES.documentTextOrderOverrides);
    store.createIndex('bookId', 'bookId');
    store.createIndex('bookId_pageIndex', ['bookId', 'pageIndex'], { unique: true });
    store.createIndex('pageHash', 'pageHash');
    store.createIndex('updatedAt', 'updatedAt');
  }
  if (!db.objectStoreNames.contains(DOCUMENT_LISTENING_STORES.documentSearchTerms)) {
    const store = createStore(db, DOCUMENT_LISTENING_STORES.documentSearchTerms);
    store.createIndex('bookId', 'bookId');
    store.createIndex('term', 'term');
    store.createIndex('bookId_term', ['bookId', 'term']);
  }
  if (!db.objectStoreNames.contains(DOCUMENT_LISTENING_STORES.documentAnnotations)) {
    const store = createStore(db, DOCUMENT_LISTENING_STORES.documentAnnotations);
    store.createIndex('bookId', 'bookId');
    store.createIndex('bookId_pageIndex', ['bookId', 'pageIndex']);
    store.createIndex('type', 'type');
    store.createIndex('updatedAt', 'updatedAt');
  }
  if (!db.objectStoreNames.contains(DOCUMENT_LISTENING_STORES.comicProfiles)) {
    const store = createStore(db, DOCUMENT_LISTENING_STORES.comicProfiles);
    store.createIndex('bookId', 'bookId', { unique: true });
  }
  if (!db.objectStoreNames.contains(DOCUMENT_LISTENING_STORES.spokenTextRules)) {
    const store = createStore(db, DOCUMENT_LISTENING_STORES.spokenTextRules);
    store.createIndex('bookId', 'bookId');
    store.createIndex('updatedAt', 'updatedAt');
  }
}
