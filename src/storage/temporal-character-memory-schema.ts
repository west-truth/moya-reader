export const TEMPORAL_CHARACTER_MEMORY_STORES = {
  addressEvents: 'temporal_address_events',
  relationEdges: 'temporal_relation_edges',
  snapshots: 'character_temporal_snapshots',
} as const;

function createRevisionStore(db: IDBDatabase, name: string): IDBObjectStore {
  const store = db.createObjectStore(name, { keyPath: 'id' });
  store.createIndex('bookId', 'bookId');
  store.createIndex('contentRevisionId', 'contentRevisionId');
  return store;
}

export function upgradeTemporalCharacterMemoryStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(TEMPORAL_CHARACTER_MEMORY_STORES.addressEvents)) {
    const store = createRevisionStore(db, TEMPORAL_CHARACTER_MEMORY_STORES.addressEvents);
    store.createIndex('chapterId', 'chapterId');
    store.createIndex('sceneId', 'sceneId');
    store.createIndex('contentRevisionId_chapterId', ['contentRevisionId', 'chapterId']);
    store.createIndex('contentRevisionId_sceneId', ['contentRevisionId', 'sceneId']);
    store.createIndex('supersedesEventId', 'supersedesEventId');
  }
  if (!db.objectStoreNames.contains(TEMPORAL_CHARACTER_MEMORY_STORES.relationEdges)) {
    const store = createRevisionStore(db, TEMPORAL_CHARACTER_MEMORY_STORES.relationEdges);
    store.createIndex('subjectSpeakerEntityId', 'subjectSpeakerEntityId');
    store.createIndex('objectSpeakerEntityId', 'objectSpeakerEntityId');
    store.createIndex('observedAtSceneId', 'observedAtSceneId');
    store.createIndex('supersedesEdgeId', 'supersedesEdgeId');
  }
  if (!db.objectStoreNames.contains(TEMPORAL_CHARACTER_MEMORY_STORES.snapshots)) {
    const store = createRevisionStore(db, TEMPORAL_CHARACTER_MEMORY_STORES.snapshots);
    store.createIndex('chapterId', 'chapterId');
    store.createIndex('sceneId', 'sceneId');
    store.createIndex('contentRevisionId_chapterId', ['contentRevisionId', 'chapterId']);
    store.createIndex('contentRevisionId_sceneId_mode', ['contentRevisionId', 'sceneId', 'readerMode'], {
      unique: true,
    });
  }
}
