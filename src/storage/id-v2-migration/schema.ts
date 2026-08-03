import { ID_V2_MIGRATION_STORES } from './contracts';

function createStore(db: IDBDatabase, name: string): IDBObjectStore {
  return db.createObjectStore(name, { keyPath: 'id' });
}

export function upgradeIdV2MigrationStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(ID_V2_MIGRATION_STORES.runs)) {
    const store = createStore(db, ID_V2_MIGRATION_STORES.runs);
    store.createIndex('status', 'status');
    store.createIndex('oldNovelId', 'oldNovelId', { unique: true });
    store.createIndex('newNovelId', 'newNovelId');
  }
  if (!db.objectStoreNames.contains(ID_V2_MIGRATION_STORES.mappings)) {
    const store = createStore(db, ID_V2_MIGRATION_STORES.mappings);
    store.createIndex('runId', 'runId');
    store.createIndex('oldLookup', ['oldNovelId', 'entityType', 'revisionScope', 'oldId'], { unique: true });
    store.createIndex('newLookup', ['newNovelId', 'entityType', 'newId']);
    store.createIndex('identityKey', 'identityKey', { unique: true });
  }
  if (!db.objectStoreNames.contains(ID_V2_MIGRATION_STORES.stage)) {
    const store = createStore(db, ID_V2_MIGRATION_STORES.stage);
    store.createIndex('runId', 'runId');
    store.createIndex('runId_kind', ['runId', 'kind']);
  }
  if (!db.objectStoreNames.contains(ID_V2_MIGRATION_STORES.quarantine)) {
    const store = createStore(db, ID_V2_MIGRATION_STORES.quarantine);
    store.createIndex('runId', 'runId');
    store.createIndex('oldNovelId', 'oldNovelId');
    store.createIndex('entityType', 'entityType');
  }
}
