export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function readAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  const tx = db.transaction(storeName, 'readonly');
  const done = transactionDone(tx);
  const values = await requestToPromise<T[]>(tx.objectStore(storeName).getAll());
  await done;
  return values;
}

export async function readAllByIndex<T>(
  db: IDBDatabase,
  storeName: string,
  indexName: string,
  query: IDBValidKey | IDBKeyRange,
): Promise<T[]> {
  const tx = db.transaction(storeName, 'readonly');
  const done = transactionDone(tx);
  const values = await requestToPromise<T[]>(tx.objectStore(storeName).index(indexName).getAll(query));
  await done;
  return values;
}

export async function readOne<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const tx = db.transaction(storeName, 'readonly');
  const done = transactionDone(tx);
  const value = await requestToPromise<T | undefined>(tx.objectStore(storeName).get(key));
  await done;
  return value;
}

export function recordKey(value: Record<string, unknown>, keyPath = 'id'): string {
  const key = value[keyPath];
  if (typeof key !== 'string' || !key) throw new Error(`Migration record has no string ${keyPath}`);
  return key;
}

export function cloneRecord<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}
