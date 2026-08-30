import type { Novel } from '../domain/types';
import type {
  BookLifecycleExpectation,
  CatalogMutationReceipt,
} from '../repositories/library-catalog-repository';
import { BOOK_DATA_STORES, deleteBookDataInTransaction } from './book-data-cleanup';
import { deleteBookAssetsInTransaction } from './book-asset-store';
import { BOOK_ASSET_STORES } from './book-asset-schema';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';
import { getTrashedNovels } from './reader-query-store';
import { jsonValue, LOCAL_DEVICE_ID, queueSyncEventInTransaction } from './sync-event-store';
import type { SyncTombstone } from './sync-event-store';
import { BOOK_ENRICHMENT_STORES } from './book-enrichment-schema';
import { deleteBookEnrichmentDataInTransaction } from './book-enrichment-store';
import { canonicalRemoteContentRevisionId } from './content-revision-identity';
import { CONTENT_REVISION_STORES } from './content-revision-migration';

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

function assertLifecycleExpectation(novel: Novel, expectation?: BookLifecycleExpectation): void {
  const actual = novel.metadataRevision ?? 0;
  const expectedRevision = expectation?.metadataRevision;
  if (expectedRevision !== undefined && expectedRevision !== actual) {
    throw new CatalogRevisionConflictError(novel.id, expectedRevision, actual);
  }
  if (
    expectation?.activeContentRevisionId !== undefined &&
    expectation.activeContentRevisionId !== novel.activeContentRevisionId
  ) {
    throw new Error(`Book ${novel.id} content revision changed before lifecycle mutation`);
  }
}

export function bookVaultTombstone(
  novel: Novel,
  deletedAt: string,
  options: { readonly purged?: boolean; readonly contentRevisionId?: string } = {},
): SyncTombstone {
  const vaultBookId = novel.cloudVaultBookId ?? novel.id;
  return {
    id: `book:${vaultBookId}`,
    entityType: 'book',
    entityId: vaultBookId,
    novelId: novel.id,
    vaultBookId,
    bookHash: novel.normalizedTextHash,
    ...(options.contentRevisionId ? { contentRevisionId: options.contentRevisionId } : undefined),
    ...(options.purged ? { purged: true } : undefined),
    deletedAt,
    createdAt: deletedAt,
  };
}

export { getTrashedNovels };

const LIBRARY_PURGE_STORES = [
  'novels',
  ...BOOK_DATA_STORES,
  BOOK_ASSET_STORES.assets,
  BOOK_ASSET_STORES.blobs,
  ...Object.values(BOOK_ENRICHMENT_STORES),
  'devices',
  'sync_outbox',
  'sync_state',
] as const;

async function purgeNovelInTransaction(tx: IDBTransaction, novel: Novel, purgedAt: string): Promise<void> {
  const canonicalContentRevisionId = await canonicalRemoteContentRevisionId(tx, novel);
  tx.objectStore('novels').delete(novel.id);
  deleteBookDataInTransaction(tx, novel.id, { preserveSyncTombstones: true });
  deleteBookAssetsInTransaction(tx, novel.id);
  deleteBookEnrichmentDataInTransaction(tx, novel.id);
  tx.objectStore('sync_tombstones').put(
    bookVaultTombstone(novel, purgedAt, {
      purged: true,
      contentRevisionId: novel.activeContentRevisionId,
    }),
  );
  await queueSyncEventInTransaction(
    tx,
    'book_purged',
    jsonValue({
      bookId: novel.id,
      vaultBookId: novel.cloudVaultBookId ?? novel.id,
      vaultLegacyContentHash: novel.normalizedTextHash,
      purgedAt,
      metadataRevision: (novel.metadataRevision ?? 0) + 1,
      contentRevisionId: canonicalContentRevisionId,
    }),
    { novelId: novel.id, entityId: novel.id },
  );
}

export async function moveNovelToTrash(
  bookId: string,
  expectation?: BookLifecycleExpectation,
): Promise<CatalogMutationReceipt> {
  const db = await openReaderDb();
  const tx = db.transaction(
    ['novels', CONTENT_REVISION_STORES.revisions, 'sync_tombstones', 'devices', 'sync_outbox', 'sync_state'],
    'readwrite',
  );
  const done = transactionDone(tx);
  const store = tx.objectStore('novels');
  const novel = await requestToPromise<Novel | undefined>(store.get(bookId));
  if (!novel) {
    await done;
    throw new Error(`Book ${bookId} was not found`);
  }
  assertLifecycleExpectation(novel, expectation);
  const canonicalContentRevisionId = await canonicalRemoteContentRevisionId(tx, novel);
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
  tx.objectStore('sync_tombstones').put(bookVaultTombstone(novel, deletedAt));
  await queueSyncEventInTransaction(
    tx,
    'book_trashed',
    jsonValue({
      bookId,
      deletedAt,
      deletedByDeviceId: LOCAL_DEVICE_ID,
      metadataRevision: receipt.metadataRevision,
      contentRevisionId: canonicalContentRevisionId,
    }),
    { novelId: bookId, entityId: bookId },
  );
  await done;
  return receipt;
}

export async function restoreNovelFromTrash(
  bookId: string,
  expectation?: BookLifecycleExpectation,
): Promise<CatalogMutationReceipt> {
  const db = await openReaderDb();
  const tx = db.transaction(
    ['novels', CONTENT_REVISION_STORES.revisions, 'sync_tombstones', 'devices', 'sync_outbox', 'sync_state'],
    'readwrite',
  );
  const done = transactionDone(tx);
  const store = tx.objectStore('novels');
  const novel = await requestToPromise<Novel | undefined>(store.get(bookId));
  if (!novel) {
    await done;
    throw new Error(`Book ${bookId} was not found`);
  }
  assertLifecycleExpectation(novel, expectation);
  const canonicalContentRevisionId = await canonicalRemoteContentRevisionId(tx, novel);
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
  tx.objectStore('sync_tombstones').delete(`book:${novel.cloudVaultBookId ?? novel.id}`);
  await queueSyncEventInTransaction(
    tx,
    'book_restored',
    jsonValue({
      bookId,
      restoredAt,
      metadataRevision: receipt.metadataRevision,
      contentRevisionId: canonicalContentRevisionId,
    }),
    { novelId: bookId, entityId: bookId },
  );
  await done;
  return receipt;
}

export async function purgeNovel(bookId: string, expectation?: BookLifecycleExpectation): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction([...LIBRARY_PURGE_STORES], 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore('novels');
  const novel = await requestToPromise<Novel | undefined>(store.get(bookId));
  if (!novel) {
    await done;
    return;
  }
  assertLifecycleExpectation(novel, expectation);
  if (!novel.deletedAt) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('Only books in the trash can be permanently deleted');
  }
  const purgedAt = new Date().toISOString();
  await purgeNovelInTransaction(tx, novel, purgedAt);
  await done;
}

export async function emptyNovelTrash(): Promise<{ purged: number; bookIds: readonly string[] }> {
  const db = await openReaderDb();
  const tx = db.transaction([...LIBRARY_PURGE_STORES], 'readwrite');
  const done = transactionDone(tx);
  const novels = await requestToPromise<Novel[]>(tx.objectStore('novels').getAll());
  const trashed = novels.filter((novel) => Boolean(novel.deletedAt));
  const purgedAt = new Date().toISOString();
  for (const novel of trashed) await purgeNovelInTransaction(tx, novel, purgedAt);
  await done;
  return { purged: trashed.length, bookIds: trashed.map((novel) => novel.id) };
}

export async function listBookAssociationPurgeEvidence(): Promise<
  readonly { readonly bookId: string; readonly activeContentRevisionId?: string }[]
> {
  const db = await openReaderDb();
  const tx = db.transaction('sync_tombstones', 'readonly');
  const done = transactionDone(tx);
  const tombstones = await requestToPromise<SyncTombstone[]>(tx.objectStore('sync_tombstones').getAll());
  await done;
  return tombstones
    .filter((tombstone) => tombstone.entityType === 'book' && tombstone.purged && Boolean(tombstone.novelId))
    .map((tombstone) => ({
      bookId: tombstone.novelId!,
      activeContentRevisionId: tombstone.contentRevisionId,
    }));
}
