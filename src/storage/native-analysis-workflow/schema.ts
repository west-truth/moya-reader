export const NATIVE_ANALYSIS_STORES = {
  workflows: 'native_analysis_workflows',
  descriptors: 'native_analysis_workflow_descriptors',
  staging: 'native_analysis_staging',
  provenance: 'native_analysis_provenance',
} as const;

function createStore(db: IDBDatabase, name: string): IDBObjectStore {
  return db.createObjectStore(name, { keyPath: 'id' });
}

export function upgradeNativeAnalysisWorkflowStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(NATIVE_ANALYSIS_STORES.descriptors)) {
    const store = db.createObjectStore(NATIVE_ANALYSIS_STORES.descriptors, { keyPath: 'workflowId' });
    store.createIndex('novelId', 'novelId');
  }
  if (!db.objectStoreNames.contains(NATIVE_ANALYSIS_STORES.workflows)) {
    const store = createStore(db, NATIVE_ANALYSIS_STORES.workflows);
    store.createIndex('novelId', 'novelId');
    store.createIndex('workflowId', 'workflowId', { unique: true });
  }
  if (!db.objectStoreNames.contains(NATIVE_ANALYSIS_STORES.staging)) {
    const store = createStore(db, NATIVE_ANALYSIS_STORES.staging);
    store.createIndex('novelId', 'novelId');
    store.createIndex('workflowId', 'workflowId');
    store.createIndex('jobId', 'jobId');
    store.createIndex('status', 'status');
    store.createIndex('workflowId_jobId_fence', ['workflowId', 'jobId', 'workflowFence']);
  }
  if (!db.objectStoreNames.contains(NATIVE_ANALYSIS_STORES.provenance)) {
    const store = createStore(db, NATIVE_ANALYSIS_STORES.provenance);
    store.createIndex('novelId', 'novelId');
    store.createIndex('workflowId', 'workflowId');
    store.createIndex('jobId', 'jobId');
    store.createIndex('artifactId', 'artifactId', { unique: true });
    store.createIndex('workflowId_jobId_fence', ['workflowId', 'jobId', 'workflowFence'], { unique: true });
  }
}
