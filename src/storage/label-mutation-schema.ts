export const LABEL_MUTATION_STORES = {
  receipts: 'label_mutation_receipts',
  invalidations: 'label_mutation_invalidations',
  relabelPlans: 'label_reanalysis_plans',
} as const;

function createStore(db: IDBDatabase, name: string): IDBObjectStore {
  return db.createObjectStore(name, { keyPath: 'id' });
}

export function upgradeLabelMutationStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(LABEL_MUTATION_STORES.receipts)) {
    const store = createStore(db, LABEL_MUTATION_STORES.receipts);
    store.createIndex('novelId', 'novelId');
    store.createIndex('chapterId', 'chapterId');
  }
  if (!db.objectStoreNames.contains(LABEL_MUTATION_STORES.invalidations)) {
    const store = createStore(db, LABEL_MUTATION_STORES.invalidations);
    store.createIndex('novelId', 'novelId');
    store.createIndex('chapterId', 'chapterId');
    store.createIndex('status', 'status');
  }
  if (!db.objectStoreNames.contains(LABEL_MUTATION_STORES.relabelPlans)) {
    const store = createStore(db, LABEL_MUTATION_STORES.relabelPlans);
    store.createIndex('novelId', 'novelId');
    store.createIndex('chapterId', 'chapterId');
    store.createIndex('status', 'status');
  }
}
