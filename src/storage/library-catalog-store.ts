import type { Novel } from '../domain/types';
import type { CatalogMutationReceipt } from '../repositories/library-catalog-repository';
import { BOOK_DATA_STORES, deleteBookDataInTransaction } from './book-data-cleanup';
import { deleteBookAssetsInTransaction } from './book-asset-store';
import { BOOK_ASSET_STORES } from './book-asset-schema';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';
import { getTrashedNovels } from './reader-query-store';
import { jsonValue, LOCAL_DEVICE_ID, queueSyncEventInTransaction } from './sync-event-store';

export class CatalogRevisionConflictError extends Error {
  constructor(
    public readonly bookId: string,
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super(`Book ${bookId} metadata revision changed from ${expectedRevision} to ${actualRevision}`);
    this.name = 'CatalogRevisionConflictError';
  }
}

function nextReceipt(novel: Novel, changedAt: string): CatalogMutationReceipt {
  return {
    bookId: novel.id,
    metadataRevision: (novel.metadataRevision ?? 0) + 1,
    changedAt,
  };
}

function assertExpectedRevision(novel: Novel, expectedRevision?: number): void {
  const actual = novel.metadataRevision ?? 0;
  if (expectedRevision !== undefined && expectedRevision !== actual) {
    throw new CatalogRevisionConflictError(novel.id, expectedRevision, actual);
  }
}

export { getTrashedNovels };

export async function moveNovelToTrash(bookId: string, expectedRevision?: number): Promise<CatalogMutationReceipt> {
  const db = await openReaderDb();
  const tx = db.transaction(['novels', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore('novels');
  const novel = await requestToPromise<Novel | undefined>(store.get(bookId));
  if (!novel) {
    await done;
    throw new Error(`Book ${bookId} was not found`);
  }
  assertExpectedRevision(novel, expectedRevision);
  if (novel.deletedAt) {
    await done;
    return {
      bookId,
      metadataRevision: novel.metadataRevision ?? 0,
      changedAt: novel.deletedAt,
    };
  }
  const deletedAt = new Date().toISOString();
  const receipt = nextReceipt(novel, deletedAt);
  store.put({
    ...novel,
    deletedAt,
    deletedByDeviceId: LOCAL_DEVICE_ID,
    metadataRevision: receipt.metadataRevision,
    updatedAt: deletedAt,
  } satisfies Novel);
  await queueSyncEventInTransaction(
    tx,
    'book_trashed',
    jsonValue({ bookId, deletedAt, deletedByDeviceId: LOCAL_DEVICE_ID, metadataRevision: receipt.metadataRevision }),
    { novelId: bookId, entityId: bookId },
  );
  await done;
  return receipt;
}

export async function restoreNovelFromTrash(
  bookId: string,
  expectedRevision?: number,
): Promise<CatalogMutationReceipt> {
  const db = await openReaderDb();
  const tx = db.transaction(['novels', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore('novels');
  const novel = await requestToPromise<Novel | undefined>(store.get(bookId));
  if (!novel) {
    await done;
    throw new Error(`Book ${bookId} was not found`);
  }
  assertExpectedRevision(novel, expectedRevision);
  if (!novel.deletedAt) {
    await done;
    return { bookId, metadataRevision: novel.metadataRevision ?? 0, changedAt: novel.updatedAt };
  }
  const restoredAt = new Date().toISOString();
  const receipt = nextReceipt(novel, restoredAt);
  const restored: Novel = {
    ...novel,
    deletedAt: undefined,
    deletedByDeviceId: undefined,
    metadataRevision: receipt.metadataRevision,
    updatedAt: restoredAt,
  };
  store.put(restored);
  await queueSyncEventInTransaction(
    tx,
    'book_restored',
    jsonValue({ bookId, restoredAt, metadataRevision: receipt.metadataRevision }),
    { novelId: bookId, entityId: bookId },
  );
  await done;
  return receipt;
}

export async function purgeNovel(bookId: string, expectedRevision?: number): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(
    [
      'novels',
      ...BOOK_DATA_STORES,
      BOOK_ASSET_STORES.assets,
      BOOK_ASSET_STORES.blobs,
      'devices',
      'sync_outbox',
      'sync_state',
    ],
    'readwrite',
  );
  const done = transactionDone(tx);
  const store = tx.objectStore('novels');
  const novel = await requestToPromise<Novel | undefined>(store.get(bookId));
  if (!novel) {
    await done;
    return;
  }
  assertExpectedRevision(novel, expectedRevision);
  if (!novel.deletedAt) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('Only books in the trash can be permanently deleted');
  }
  const purgedAt = new Date().toISOString();
  store.delete(bookId);
  deleteBookDataInTransaction(tx, bookId);
  deleteBookAssetsInTransaction(tx, bookId);
  await queueSyncEventInTransaction(
    tx,
    'book_purged',
    jsonValue({ bookId, purgedAt, metadataRevision: (novel.metadataRevision ?? 0) + 1 }),
    { novelId: bookId, entityId: bookId },
  );
  await done;
}

export async function emptyNovelTrash(): Promise<number> {
  const trashed = await getTrashedNovels();
  for (const novel of trashed) await purgeNovel(novel.id, novel.metadataRevision ?? 0);
  return trashed.length;
}
