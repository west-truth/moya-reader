import type { LinkedLibraryFolder, StoredLibraryFolderEntry } from './contracts';

const DB_NAME = 'noveldesk-library-folders';
const DB_VERSION = 1;

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

function openLibraryFolderDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      if (!db.objectStoreNames.contains('entries')) {
        const store = db.createObjectStore('entries', { keyPath: 'id' });
        store.createIndex('folderId', 'folderId');
        store.createIndex('bookId', 'bookId');
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

export class LibraryFolderLocalStateStore {
  async listFolders(): Promise<LinkedLibraryFolder[]> {
    const db = await openLibraryFolderDb();
    const tx = db.transaction('folders', 'readonly');
    return requestToPromise<LinkedLibraryFolder[]>(tx.objectStore('folders').getAll());
  }

  async saveFolder(folder: LinkedLibraryFolder): Promise<void> {
    const db = await openLibraryFolderDb();
    const tx = db.transaction('folders', 'readwrite');
    tx.objectStore('folders').put(folder);
    await transactionDone(tx);
  }

  async deleteFolder(folderId: string): Promise<void> {
    const db = await openLibraryFolderDb();
    const tx = db.transaction(['folders', 'handles', 'entries'], 'readwrite');
    tx.objectStore('folders').delete(folderId);
    tx.objectStore('handles').delete(folderId);
    const entryStore = tx.objectStore('entries');
    const request = entryStore.index('folderId').openKeyCursor(IDBKeyRange.only(folderId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      entryStore.delete(cursor.primaryKey);
      cursor.continue();
    };
    await transactionDone(tx);
  }

  async getDirectoryHandle(folderId: string): Promise<FileSystemDirectoryHandle | undefined> {
    const db = await openLibraryFolderDb();
    const tx = db.transaction('handles', 'readonly');
    return requestToPromise<FileSystemDirectoryHandle | undefined>(tx.objectStore('handles').get(folderId));
  }

  async saveDirectoryHandle(folderId: string, handle: FileSystemDirectoryHandle): Promise<void> {
    const db = await openLibraryFolderDb();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, folderId);
    await transactionDone(tx);
  }

  async clearDirectoryHandle(folderId: string): Promise<void> {
    const db = await openLibraryFolderDb();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').delete(folderId);
    await transactionDone(tx);
  }

  async listEntries(folderId: string): Promise<StoredLibraryFolderEntry[]> {
    const db = await openLibraryFolderDb();
    const tx = db.transaction('entries', 'readonly');
    return requestToPromise<StoredLibraryFolderEntry[]>(
      tx.objectStore('entries').index('folderId').getAll(IDBKeyRange.only(folderId)),
    );
  }

  async saveEntries(entries: readonly StoredLibraryFolderEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const db = await openLibraryFolderDb();
    const tx = db.transaction('entries', 'readwrite');
    const store = tx.objectStore('entries');
    entries.forEach((entry) => store.put(entry));
    await transactionDone(tx);
  }

  async deleteEntry(id: string): Promise<void> {
    const db = await openLibraryFolderDb();
    const tx = db.transaction('entries', 'readwrite');
    tx.objectStore('entries').delete(id);
    await transactionDone(tx);
  }
}

export async function resetLibraryFolderLocalStateForTests(): Promise<void> {
  dbPromise?.then((db) => db.close()).catch(() => undefined);
  dbPromise = undefined;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Library folder state database deletion is blocked.'));
  });
}
