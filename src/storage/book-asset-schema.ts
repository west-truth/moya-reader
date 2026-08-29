import type { BookAssetMetadata } from '../domain/types';

export const BOOK_ASSET_STORES = {
  assets: 'book_assets',
  blobs: 'book_asset_blobs',
} as const;

export type StoredBookAsset = BookAssetMetadata;

export interface StoredBookAssetBlob {
  id: string;
  contentHash: string;
  contentType: string;
  byteLength: number;
  blob: Blob;
  createdAt: string;
}

export function upgradeBookAssetStores(db: IDBDatabase, transaction?: IDBTransaction): void {
  if (!db.objectStoreNames.contains(BOOK_ASSET_STORES.assets)) {
    const store = db.createObjectStore(BOOK_ASSET_STORES.assets, { keyPath: 'id' });
    store.createIndex('bookId', 'bookId');
    store.createIndex('contentRevisionId', 'contentRevisionId');
    store.createIndex('storageKey', 'storageKey');
    store.createIndex('status', 'status');
    store.createIndex('bookId_kind_status', ['bookId', 'kind', 'status']);
  } else if (transaction) {
    const store = transaction.objectStore(BOOK_ASSET_STORES.assets);
    if (!store.indexNames.contains('status')) store.createIndex('status', 'status');
  }
  if (!db.objectStoreNames.contains(BOOK_ASSET_STORES.blobs)) {
    const store = db.createObjectStore(BOOK_ASSET_STORES.blobs, { keyPath: 'id' });
    store.createIndex('contentHash', 'contentHash', { unique: true });
  }
}
