import type {
  ExternalCatalogCachePage,
  ExternalSourceCredentialRecord,
  ExternalSourceLink,
  ExternalSourceSelectionRecord,
} from './contracts';
import { createExternalSourceCredentialKey } from './device-credential-crypto';

const DB_NAME = 'noveldesk-external-sources';
const DB_VERSION = 4;
const MAX_CACHE_PAGES_PER_CONNECTION = 24;
const CREDENTIAL_KEY_ID = 'external-source-credentials-v1';

let dbPromise: Promise<IDBDatabase> | undefined;
let credentialKeyPromise: Promise<CryptoKey> | undefined;

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

function openExternalSourceDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('credentials')) {
        const store = db.createObjectStore('credentials', { keyPath: 'id' });
        store.createIndex('connectorId', 'connectorId');
      }
      if (!db.objectStoreNames.contains('cachePages')) {
        const store = db.createObjectStore('cachePages', { keyPath: 'id' });
        store.createIndex('connectorId', 'connectorId');
        store.createIndex('accountConnectionId', 'accountConnectionId');
      }
      if (!db.objectStoreNames.contains('links')) {
        const store = db.createObjectStore('links', { keyPath: 'id' });
        store.createIndex('connectorId', 'source.connectorId');
        store.createIndex('localBookId', 'localBookId');
      }
      if (!db.objectStoreNames.contains('credentialKeys')) {
        db.createObjectStore('credentialKeys', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('browsePreferences')) {
        const store = db.createObjectStore('browsePreferences', { keyPath: 'id' });
        store.createIndex('connectorId', 'connectorId');
      }
      if (!db.objectStoreNames.contains('selectedItems')) {
        const store = db.createObjectStore('selectedItems', { keyPath: 'id' });
        store.createIndex('connectorId', 'connectorId');
        store.createIndex('accountConnectionId', 'accountConnectionId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      if (dbPromise === opening) dbPromise = undefined;
      reject(request.error);
    };
  });
  dbPromise = opening;
  return opening;
}

export interface ExternalSourceFolderBreadcrumb {
  readonly label: string;
  readonly parentRef: string;
}

export interface ExternalSourceDefaultFolder {
  readonly id: string;
  readonly connectorId: string;
  readonly accountConnectionId?: string;
  readonly parentRef: string;
  readonly breadcrumbs: readonly ExternalSourceFolderBreadcrumb[];
  readonly updatedAt: string;
  readonly schemaVersion: 1;
}

export function externalSourceDefaultFolderId(connectorId: string, accountConnectionId: string | undefined): string {
  return ['external-source-default-folder', connectorId, accountConnectionId ?? ''].join('::');
}

export interface ExternalSourceLocalState {
  getOrCreateCredentialKey(): Promise<CryptoKey>;
  getCredential(connectorId: string): Promise<ExternalSourceCredentialRecord | undefined>;
  saveCredential(record: ExternalSourceCredentialRecord): Promise<void>;
  deleteCredential(connectorId: string): Promise<void>;
  getCachePage(id: string): Promise<ExternalCatalogCachePage | undefined>;
  saveCachePage(page: ExternalCatalogCachePage): Promise<void>;
  clearCache(connectorId: string, accountConnectionId?: string): Promise<void>;
  listLinks(connectorId?: string): Promise<ExternalSourceLink[]>;
  saveLink(link: ExternalSourceLink): Promise<void>;
  getDefaultFolder(connectorId: string, accountConnectionId?: string): Promise<ExternalSourceDefaultFolder | undefined>;
  saveDefaultFolder(folder: ExternalSourceDefaultFolder): Promise<void>;
  deleteDefaultFolder(connectorId: string, accountConnectionId?: string): Promise<void>;
  listSelectedItems(connectorId: string, accountConnectionId: string): Promise<ExternalSourceSelectionRecord[]>;
  saveSelectedItem(record: ExternalSourceSelectionRecord): Promise<void>;
  deleteSelectedItem(id: string): Promise<void>;
}

export class ExternalSourceLocalStateStore implements ExternalSourceLocalState {
  async getOrCreateCredentialKey(): Promise<CryptoKey> {
    if (credentialKeyPromise) return credentialKeyPromise;
    credentialKeyPromise = this.loadOrCreateCredentialKey().catch((error) => {
      credentialKeyPromise = undefined;
      throw error;
    });
    return credentialKeyPromise;
  }

  private async loadOrCreateCredentialKey(): Promise<CryptoKey> {
    const db = await openExternalSourceDb();
    const readTx = db.transaction('credentialKeys', 'readonly');
    const existing = await requestToPromise<{ id: string; key: CryptoKey } | undefined>(
      readTx.objectStore('credentialKeys').get(CREDENTIAL_KEY_ID),
    );
    if (existing?.key) return existing.key;

    const key = await createExternalSourceCredentialKey();
    const writeTx = db.transaction('credentialKeys', 'readwrite');
    writeTx.objectStore('credentialKeys').put({ id: CREDENTIAL_KEY_ID, key, createdAt: new Date().toISOString() });
    await transactionDone(writeTx);
    return key;
  }

  async getCredential(connectorId: string): Promise<ExternalSourceCredentialRecord | undefined> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('credentials', 'readonly');
    const records = await requestToPromise<ExternalSourceCredentialRecord[]>(
      tx.objectStore('credentials').index('connectorId').getAll(IDBKeyRange.only(connectorId)),
    );
    return records[0];
  }

  async saveCredential(record: ExternalSourceCredentialRecord): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('credentials', 'readwrite');
    tx.objectStore('credentials').put(record);
    await transactionDone(tx);
  }

  async deleteCredential(connectorId: string): Promise<void> {
    const record = await this.getCredential(connectorId);
    if (!record) return;
    const db = await openExternalSourceDb();
    const tx = db.transaction('credentials', 'readwrite');
    tx.objectStore('credentials').delete(record.id);
    await transactionDone(tx);
  }

  async getCachePage(id: string): Promise<ExternalCatalogCachePage | undefined> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('cachePages', 'readonly');
    return requestToPromise<ExternalCatalogCachePage | undefined>(tx.objectStore('cachePages').get(id));
  }

  async saveCachePage(page: ExternalCatalogCachePage): Promise<void> {
    const db = await openExternalSourceDb();
    const existingTx = db.transaction('cachePages', 'readonly');
    const existing = await requestToPromise<ExternalCatalogCachePage[]>(
      existingTx.objectStore('cachePages').index('connectorId').getAll(IDBKeyRange.only(page.connectorId)),
    );
    const sameConnection = existing
      .filter((item) => item.accountConnectionId === page.accountConnectionId && item.id !== page.id)
      .sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt));

    const tx = db.transaction('cachePages', 'readwrite');
    const store = tx.objectStore('cachePages');
    store.put(page);
    sameConnection.slice(MAX_CACHE_PAGES_PER_CONNECTION - 1).forEach((item) => store.delete(item.id));
    await transactionDone(tx);
  }

  async clearCache(connectorId: string, accountConnectionId?: string): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('cachePages', 'readwrite');
    const store = tx.objectStore('cachePages');
    const request = store.index('connectorId').openCursor(IDBKeyRange.only(connectorId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const page = cursor.value as ExternalCatalogCachePage;
      if (accountConnectionId === undefined || page.accountConnectionId === accountConnectionId) cursor.delete();
      cursor.continue();
    };
    await transactionDone(tx);
  }

  async listLinks(connectorId?: string): Promise<ExternalSourceLink[]> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('links', 'readonly');
    const store = tx.objectStore('links');
    return connectorId
      ? requestToPromise<ExternalSourceLink[]>(store.index('connectorId').getAll(IDBKeyRange.only(connectorId)))
      : requestToPromise<ExternalSourceLink[]>(store.getAll());
  }

  async saveLink(link: ExternalSourceLink): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('links', 'readwrite');
    tx.objectStore('links').put(link);
    await transactionDone(tx);
  }

  async getDefaultFolder(
    connectorId: string,
    accountConnectionId?: string,
  ): Promise<ExternalSourceDefaultFolder | undefined> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('browsePreferences', 'readonly');
    return requestToPromise<ExternalSourceDefaultFolder | undefined>(
      tx.objectStore('browsePreferences').get(externalSourceDefaultFolderId(connectorId, accountConnectionId)),
    );
  }

  async saveDefaultFolder(folder: ExternalSourceDefaultFolder): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('browsePreferences', 'readwrite');
    tx.objectStore('browsePreferences').put(folder);
    await transactionDone(tx);
  }

  async deleteDefaultFolder(connectorId: string, accountConnectionId?: string): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('browsePreferences', 'readwrite');
    tx.objectStore('browsePreferences').delete(externalSourceDefaultFolderId(connectorId, accountConnectionId));
    await transactionDone(tx);
  }

  async listSelectedItems(connectorId: string, accountConnectionId: string): Promise<ExternalSourceSelectionRecord[]> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('selectedItems', 'readonly');
    const records = await requestToPromise<ExternalSourceSelectionRecord[]>(
      tx.objectStore('selectedItems').index('connectorId').getAll(IDBKeyRange.only(connectorId)),
    );
    return records
      .filter((record) => record.accountConnectionId === accountConnectionId)
      .sort((left, right) => right.selectedAt.localeCompare(left.selectedAt) || left.id.localeCompare(right.id));
  }

  async saveSelectedItem(record: ExternalSourceSelectionRecord): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('selectedItems', 'readwrite');
    tx.objectStore('selectedItems').put(record);
    await transactionDone(tx);
  }

  async deleteSelectedItem(id: string): Promise<void> {
    const db = await openExternalSourceDb();
    const tx = db.transaction('selectedItems', 'readwrite');
    tx.objectStore('selectedItems').delete(id);
    await transactionDone(tx);
  }
}

export async function resetExternalSourceLocalStateForTests(): Promise<void> {
  dbPromise?.then((db) => db.close()).catch(() => undefined);
  dbPromise = undefined;
  credentialKeyPromise = undefined;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('External source database deletion is blocked.'));
  });
}
