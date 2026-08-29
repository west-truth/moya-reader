import { DEFAULT_CLOUD_VAULT_SCOPE, type CloudVaultProviderKind, type CloudVaultSyncScope } from './contracts';
import {
  createCloudVaultDeviceKey,
  sealCloudVaultDevicePassphrase,
  unsealCloudVaultDevicePassphrase,
} from './device-passphrase';

const DB_NAME = 'noveldesk-cloud-vault';
const DB_VERSION = 2;
const CONFIG_ID = 'cloud-vault-config';
const DIRECTORY_HANDLE_ID = 'directory-handle';
const DEVICE_KEY_ID = 'device-key';
const REMEMBERED_PASSPHRASE_ID = 'remembered-passphrase';

export interface CloudVaultLocalConfig {
  readonly id: typeof CONFIG_ID;
  readonly providerKind?: CloudVaultProviderKind;
  readonly scope: CloudVaultSyncScope;
  readonly directoryName?: string;
  readonly dropboxCredentialEnvelope?: string;
  readonly dropboxAccountLabel?: string;
  readonly lastSyncAt?: string;
  readonly lastSyncProviderKind?: CloudVaultProviderKind;
  readonly lastRemoteRevision?: string;
  readonly lastUploadedBytes?: number;
  readonly lastError?: string;
  readonly waitingBookTitles: readonly string[];
  readonly aiTtsObjectKeys?: Readonly<Record<string, string>>;
  readonly rememberPassphrase: boolean;
  readonly autoSync: boolean;
  readonly updatedAt: string;
}

const defaultConfig = (): CloudVaultLocalConfig => ({
  id: CONFIG_ID,
  scope: DEFAULT_CLOUD_VAULT_SCOPE,
  waitingBookTitles: [],
  aiTtsObjectKeys: {},
  rememberPassphrase: true,
  autoSync: true,
  updatedAt: new Date(0).toISOString(),
});

let dbPromise: Promise<IDBDatabase> | undefined;
let deviceKeyPromise: Promise<CryptoKey> | undefined;

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
    let settled = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('config')) db.createObjectStore('config', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      if (!db.objectStoreNames.contains('deviceSecrets')) db.createObjectStore('deviceSecrets', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      dbPromise = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      dbPromise = undefined;
      reject(new Error('다른 Moya 탭을 닫은 뒤 이 화면을 새로고침하세요.'));
    };
  });
  return dbPromise;
}

export class CloudVaultLocalStateStore {
  private async getOrCreateDeviceKey(): Promise<CryptoKey> {
    if (deviceKeyPromise) return deviceKeyPromise;
    deviceKeyPromise = this.loadOrCreateDeviceKey().catch((error) => {
      deviceKeyPromise = undefined;
      throw error;
    });
    return deviceKeyPromise;
  }

  private async loadOrCreateDeviceKey(): Promise<CryptoKey> {
    const db = await openCloudVaultStateDb();
    const readTx = db.transaction('deviceSecrets', 'readonly');
    const existing = await requestToPromise<{ id: string; key: CryptoKey } | undefined>(
      readTx.objectStore('deviceSecrets').get(DEVICE_KEY_ID),
    );
    if (existing?.key) return existing.key;

    const key = await createCloudVaultDeviceKey();
    const writeTx = db.transaction('deviceSecrets', 'readwrite');
    writeTx.objectStore('deviceSecrets').put({ id: DEVICE_KEY_ID, key, createdAt: new Date().toISOString() });
    await transactionDone(writeTx);
    return key;
  }

  async getConfig(): Promise<CloudVaultLocalConfig> {
    const db = await openCloudVaultStateDb();
    const tx = db.transaction('config', 'readonly');
    const stored = await requestToPromise<CloudVaultLocalConfig | undefined>(tx.objectStore('config').get(CONFIG_ID));
    return {
      ...defaultConfig(),
      ...stored,
      scope: { ...DEFAULT_CLOUD_VAULT_SCOPE, ...stored?.scope, ttsAudio: false },
      waitingBookTitles: stored?.waitingBookTitles ?? [],
      aiTtsObjectKeys: stored?.aiTtsObjectKeys ?? {},
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
      aiTtsObjectKeys: patch.aiTtsObjectKeys ?? current.aiTtsObjectKeys,
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

  async saveRememberedPassphrase(passphrase: string): Promise<void> {
    const db = await openCloudVaultStateDb();
    const key = await this.getOrCreateDeviceKey();
    const envelope = await sealCloudVaultDevicePassphrase(passphrase, key);
    const tx = db.transaction('deviceSecrets', 'readwrite');
    tx.objectStore('deviceSecrets').put({
      id: REMEMBERED_PASSPHRASE_ID,
      envelope,
      updatedAt: new Date().toISOString(),
    });
    await transactionDone(tx);
  }

  async getRememberedPassphrase(): Promise<string | undefined> {
    const db = await openCloudVaultStateDb();
    const tx = db.transaction('deviceSecrets', 'readonly');
    const record = await requestToPromise<{ id: string; envelope: string } | undefined>(
      tx.objectStore('deviceSecrets').get(REMEMBERED_PASSPHRASE_ID),
    );
    if (!record?.envelope) return undefined;
    return unsealCloudVaultDevicePassphrase(record.envelope, await this.getOrCreateDeviceKey());
  }

  async clearRememberedPassphrase(): Promise<void> {
    const db = await openCloudVaultStateDb();
    const tx = db.transaction('deviceSecrets', 'readwrite');
    tx.objectStore('deviceSecrets').delete(REMEMBERED_PASSPHRASE_ID);
    await transactionDone(tx);
  }
}

export async function resetCloudVaultLocalStateForTests(): Promise<void> {
  dbPromise?.then((db) => db.close()).catch(() => undefined);
  dbPromise = undefined;
  deviceKeyPromise = undefined;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Cloud vault state database deletion is blocked.'));
  });
}
