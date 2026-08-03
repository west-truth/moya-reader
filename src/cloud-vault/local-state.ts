import { DEFAULT_CLOUD_VAULT_SCOPE, type CloudVaultProviderKind, type CloudVaultSyncScope } from './contracts';

const DB_NAME = 'noveldesk-cloud-vault';
const DB_VERSION = 1;
const CONFIG_ID = 'cloud-vault-config';
const DIRECTORY_HANDLE_ID = 'directory-handle';

export interface CloudVaultLocalConfig {
  readonly id: typeof CONFIG_ID;
  readonly providerKind?: CloudVaultProviderKind;
  readonly scope: CloudVaultSyncScope;
  readonly directoryName?: string;
  readonly dropboxCredentialEnvelope?: string;
  readonly dropboxAccountLabel?: string;
  readonly lastSyncAt?: string;
  readonly lastRemoteRevision?: string;
  readonly lastUploadedBytes?: number;
  readonly lastError?: string;
  readonly waitingBookTitles: readonly string[];
  readonly updatedAt: string;
}

const defaultConfig = (): CloudVaultLocalConfig => ({
  id: CONFIG_ID,
  scope: DEFAULT_CLOUD_VAULT_SCOPE,
  waitingBookTitles: [],
  updatedAt: new Date(0).toISOString(),
});

let dbPromise: Promise<IDBDatabase> | undefined;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function openCloudVaultStateDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('config')) db.createObjectStore('config', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = undefined;
      reject(request.error);
    };
  });
  return dbPromise;
}

export class CloudVaultLocalStateStore {
  async getConfig(): Promise<CloudVaultLocalConfig> {
    const db = await openCloudVaultStateDb();
    const tx = db.transaction('config', 'readonly');
    const stored = await requestToPromise<CloudVaultLocalConfig | undefined>(tx.objectStore('config').get(CONFIG_ID));
    return {
      ...defaultConfig(),
      ...stored,
      scope: { ...DEFAULT_CLOUD_VAULT_SCOPE, ...stored?.scope, ttsAudio: false },
      waitingBookTitles: stored?.waitingBookTitles ?? [],
    };
  }

  async saveConfig(patch: Partial<Omit<CloudVaultLocalConfig, 'id'>>): Promise<CloudVaultLocalConfig> {
    const db = await openCloudVaultStateDb();
    const current = await this.getConfig();
    const next: CloudVaultLocalConfig = {
      ...current,
      ...patch,
      id: CONFIG_ID,
      scope: { ...current.scope, ...patch.scope, ttsAudio: false },
      waitingBookTitles: patch.waitingBookTitles ?? current.waitingBookTitles,
      updatedAt: new Date().toISOString(),
    };
    const tx = db.transaction('config', 'readwrite');
    tx.objectStore('config').put(next);
    await transactionDone(tx);
    return next;
  }

  async getDirectoryHandle(): Promise<FileSystemDirectoryHandle | undefined> {
    const db = await openCloudVaultStateDb();
    const tx = db.transaction('handles', 'readonly');
    return requestToPromise<FileSystemDirectoryHandle | undefined>(tx.objectStore('handles').get(DIRECTORY_HANDLE_ID));
  }

  async saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    const db = await openCloudVaultStateDb();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, DIRECTORY_HANDLE_ID);
    await transactionDone(tx);
  }

  async clearDirectoryHandle(): Promise<void> {
    const db = await openCloudVaultStateDb();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').delete(DIRECTORY_HANDLE_ID);
    await transactionDone(tx);
  }
}

export async function resetCloudVaultLocalStateForTests(): Promise<void> {
  dbPromise?.then((db) => db.close()).catch(() => undefined);
  dbPromise = undefined;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Cloud vault state database deletion is blocked.'));
  });
}
