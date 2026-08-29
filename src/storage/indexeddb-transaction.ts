import { openReaderDb, type ReaderStoreName } from './reader-database';
import { requestToPromise } from './indexeddb-request';

export { requestToPromise } from './indexeddb-request';

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function getAllRecords<T>(storeName: ReaderStoreName): Promise<T[]> {
  const db = await openReaderDb();
  const tx = db.transaction(storeName, 'readonly');
  return requestToPromise<T[]>(tx.objectStore(storeName).getAll());
}

export async function getAllByIndex<T>(
  storeName: ReaderStoreName,
  indexName: string,
  query: IDBValidKey | IDBKeyRange,
): Promise<T[]> {
  const db = await openReaderDb();
  const tx = db.transaction(storeName, 'readonly');
  return requestToPromise<T[]>(tx.objectStore(storeName).index(indexName).getAll(query));
}

export async function getByIndex<T>(
  storeName: ReaderStoreName,
  indexName: string,
  query: IDBValidKey | IDBKeyRange,
): Promise<T | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(storeName, 'readonly');
  return requestToPromise<T | undefined>(tx.objectStore(storeName).index(indexName).get(query));
}

export async function getItem<T>(storeName: ReaderStoreName, id: string): Promise<T | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(storeName, 'readonly');
  return requestToPromise<T | undefined>(tx.objectStore(storeName).get(id));
}

export async function putItem<T extends { id: string }>(storeName: ReaderStoreName, item: T): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(item);
  await transactionDone(tx);
}

export async function replaceByIndex<T extends { id: string }>(
  storeName: ReaderStoreName,
  indexName: string,
  query: IDBValidKey | IDBKeyRange,
  items: T[],
): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  const request = store.index(indexName).openKeyCursor(query);
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor) {
      store.delete(cursor.primaryKey);
      cursor.continue();
      return;
    }
    items.forEach((item) => store.put(item));
  };
  await transactionDone(tx);
}

export function deleteByIndexInTransaction(
  tx: IDBTransaction,
  storeName: ReaderStoreName,
  indexName: string,
  query: IDBValidKey | IDBKeyRange,
): void {
  const store = tx.objectStore(storeName);
  const request = store.index(indexName).openKeyCursor(query);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    store.delete(cursor.primaryKey);
    cursor.continue();
  };
}
