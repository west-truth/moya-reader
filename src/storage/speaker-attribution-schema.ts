export const SPEAKER_ATTRIBUTION_STORES = {
  manifests: 'speaker_source_manifests',
  chapterInventories: 'speaker_chapter_inventories',
  scenes: 'speaker_scenes',
  spans: 'speaker_spans',
  dialogueBursts: 'speaker_dialogue_bursts',
  mentions: 'speaker_mentions',
  entities: 'speaker_entities',
  addressEvents: 'speaker_address_events',
} as const;

function createDerivedStore(db: IDBDatabase, name: string): IDBObjectStore {
  const store = db.createObjectStore(name, { keyPath: 'id' });
  store.createIndex('bookId', 'bookId');
  store.createIndex('contentRevisionId', 'contentRevisionId');
  store.createIndex('chapterId', 'chapterId');
  store.createIndex('contentRevisionId_chapterId', ['contentRevisionId', 'chapterId']);
  return store;
}

export function upgradeSpeakerAttributionStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(SPEAKER_ATTRIBUTION_STORES.manifests)) {
    const store = db.createObjectStore(SPEAKER_ATTRIBUTION_STORES.manifests, { keyPath: 'id' });
    store.createIndex('bookId', 'bookId');
    store.createIndex('contentRevisionId', 'contentRevisionId', { unique: true });
  }
  if (!db.objectStoreNames.contains(SPEAKER_ATTRIBUTION_STORES.chapterInventories)) {
    const store = createDerivedStore(db, SPEAKER_ATTRIBUTION_STORES.chapterInventories);
    store.createIndex('contentRevisionId_chapterId_unique', ['contentRevisionId', 'chapterId'], { unique: true });
  }
  for (const name of [
    SPEAKER_ATTRIBUTION_STORES.scenes,
    SPEAKER_ATTRIBUTION_STORES.spans,
    SPEAKER_ATTRIBUTION_STORES.dialogueBursts,
    SPEAKER_ATTRIBUTION_STORES.mentions,
    SPEAKER_ATTRIBUTION_STORES.entities,
    SPEAKER_ATTRIBUTION_STORES.addressEvents,
  ]) {
    if (db.objectStoreNames.contains(name)) continue;
    const store = createDerivedStore(db, name);
    if (name === SPEAKER_ATTRIBUTION_STORES.scenes) {
      store.createIndex('chapterId_sceneIndex', ['chapterId', 'sceneIndex']);
    } else if (name === SPEAKER_ATTRIBUTION_STORES.spans) {
      store.createIndex('sceneId', 'sceneId');
      store.createIndex('paragraphId', 'paragraphId');
    } else if (name === SPEAKER_ATTRIBUTION_STORES.dialogueBursts) {
      store.createIndex('sceneId', 'sceneId');
    } else if (name === SPEAKER_ATTRIBUTION_STORES.mentions) {
      store.createIndex('sceneId', 'sceneId');
      store.createIndex('spanId', 'spanId');
      store.createIndex('normalizedSurface', 'normalizedSurface');
      store.createIndex('chapterId_normalizedSurface', ['chapterId', 'normalizedSurface']);
    } else if (name === SPEAKER_ATTRIBUTION_STORES.entities) {
      store.createIndex('sceneId', 'sceneId');
      store.createIndex('characterId', 'characterId');
    } else if (name === SPEAKER_ATTRIBUTION_STORES.addressEvents) {
      store.createIndex('sceneId', 'sceneId');
      store.createIndex('spanId', 'spanId');
      store.createIndex('mentionId', 'mentionId');
    }
  }
}
