import type { BatchLibraryReceipt } from '../repositories/library-catalog-repository';
import type { Shelf, ShelfMembership } from '../domain/types';

export const LIBRARY_MANAGEMENT_STORES = {
  shelves: 'shelves',
  memberships: 'shelf_memberships',
  receipts: 'library_operation_receipts',
} as const;

export type StoredShelf = Shelf;
export type StoredShelfMembership = ShelfMembership;
export type StoredLibraryOperationReceipt = BatchLibraryReceipt;

function ensureIndex(store: IDBObjectStore, name: string, keyPath: string | string[], options?: IDBIndexParameters) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
}

export function upgradeLibraryManagementStores(db: IDBDatabase, transaction: IDBTransaction): void {
  if (!db.objectStoreNames.contains(LIBRARY_MANAGEMENT_STORES.shelves)) {
    const store = db.createObjectStore(LIBRARY_MANAGEMENT_STORES.shelves, { keyPath: 'id' });
    store.createIndex('sortOrder', 'sortOrder');
    store.createIndex('updatedAt', 'updatedAt');
  }
  if (!db.objectStoreNames.contains(LIBRARY_MANAGEMENT_STORES.memberships)) {
    const store = db.createObjectStore(LIBRARY_MANAGEMENT_STORES.memberships, { keyPath: 'id' });
    store.createIndex('shelfId', 'shelfId');
    store.createIndex('bookId', 'bookId');
    store.createIndex('shelfId_bookId', ['shelfId', 'bookId'], { unique: true });
  }
  if (!db.objectStoreNames.contains(LIBRARY_MANAGEMENT_STORES.receipts)) {
    const store = db.createObjectStore(LIBRARY_MANAGEMENT_STORES.receipts, { keyPath: 'id' });
    store.createIndex('idempotencyKey', 'idempotencyKey', { unique: true });
    store.createIndex('createdAt', 'createdAt');
  }
  const novels = transaction.objectStore('novels');
  ensureIndex(novels, 'tags', 'tags', { multiEntry: true });
  ensureIndex(novels, 'seriesTitle', 'seriesTitle');
  ensureIndex(novels, 'coverAssetId', 'coverAssetId');
}
