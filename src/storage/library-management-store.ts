import { normalizeBookMetadataPatch, type BookMetadataPatch } from '@noveldesk/text-core/library-metadata';
import { persistentId128 } from '../domain/id-hash-contract';
import type { Novel, Shelf, ShelfMembership } from '../domain/types';
import type {
  BatchLibraryCommand,
  BatchLibraryItemResult,
  BatchLibraryReceipt,
  BatchLibraryTarget,
  CatalogMutationReceipt,
  ShelfMutationReceipt,
} from '../repositories/library-catalog-repository';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { LIBRARY_MANAGEMENT_STORES } from './library-management-schema';
import { openReaderDb } from './reader-database';
import { getNovel } from './reader-query-store';
import { jsonValue, queueSyncEventInTransaction } from './sync-event-store';
import { CatalogRevisionConflictError, moveNovelToTrash, restoreNovelFromTrash } from './library-catalog-store';
import { canonicalRemoteContentRevisionId } from './content-revision-identity';
import { CONTENT_REVISION_STORES } from './content-revision-migration';

function shelfName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('책장 이름을 입력하세요.');
  if (name.length > 80) throw new Error('책장 이름은 80자 이하여야 합니다.');
  return name;
}

function shelfColor(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error('책장 색상은 6자리 HEX 값이어야 합니다.');
  return value.toLowerCase();
}

function metadataSnapshot(novel: Novel) {
  return {
    id: novel.id,
    title: novel.title,
    author: novel.author ?? null,
    seriesTitle: novel.seriesTitle ?? null,
    seriesIndex: novel.seriesIndex ?? null,
    tags: novel.tags ?? [],
    description: novel.description ?? null,
    language: novel.language ?? null,
    coverAssetId: novel.coverAssetId ?? null,
    coverContentHash: novel.coverContentHash ?? null,
    coverFit: novel.coverFit ?? 'crop',
    coverPositionX: novel.coverPositionX ?? 50,
    coverPositionY: novel.coverPositionY ?? 50,
    favorite: novel.favorite,
    analysisStatus: novel.analysisStatus,
    metadataRevision: novel.metadataRevision ?? 0,
    updatedAt: novel.updatedAt,
  };
}

export async function patchLibraryBookMetadata(
  bookId: string,
  input: BookMetadataPatch,
  expectedRevision?: number,
  expectedContentRevisionId?: string,
): Promise<CatalogMutationReceipt> {
  const patch = normalizeBookMetadataPatch(input);
  if (Object.keys(patch).length === 0) throw new Error('변경할 책 정보가 없습니다.');
  const db = await openReaderDb();
  const tx = db.transaction(
    ['novels', CONTENT_REVISION_STORES.revisions, 'devices', 'sync_outbox', 'sync_state'],
    'readwrite',
  );
  const done = transactionDone(tx);
  const store = tx.objectStore('novels');
  const current = await requestToPromise<Novel | undefined>(store.get(bookId));
  if (!current) {
    await done;
    throw new Error('책을 찾을 수 없습니다.');
  }
  const actualRevision = current.metadataRevision ?? 0;
  if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
    tx.abort();
    await done.catch(() => undefined);
    throw new CatalogRevisionConflictError(bookId, expectedRevision, actualRevision);
  }
  if (
    expectedContentRevisionId !== undefined &&
    expectedContentRevisionId !== current.activeContentRevisionId
  ) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error(`Book ${bookId} content revision changed before metadata mutation`);
  }
  const canonicalContentRevisionId = await canonicalRemoteContentRevisionId(tx, current);
  const changedAt = new Date().toISOString();
  const next: Novel = {
    ...current,
    ...patch,
    author: patch.author === null ? undefined : (patch.author ?? current.author),
    seriesTitle: patch.seriesTitle === null ? undefined : (patch.seriesTitle ?? current.seriesTitle),
    seriesIndex: patch.seriesIndex === null ? undefined : (patch.seriesIndex ?? current.seriesIndex),
    description: patch.description === null ? undefined : (patch.description ?? current.description),
    language: patch.language === null ? undefined : (patch.language ?? current.language),
    metadataRevision: actualRevision + 1,
    updatedAt: changedAt,
  };
  store.put(next);
  await queueSyncEventInTransaction(tx, 'book_updated', jsonValue({
    novel: metadataSnapshot(next),
    contentRevisionId: canonicalContentRevisionId,
  }), {
    novelId: bookId,
    entityId: bookId,
  });
  await done;
  return { bookId, metadataRevision: next.metadataRevision!, changedAt };
}

export async function listLibraryShelves(): Promise<Shelf[]> {
  const db = await openReaderDb();
  const tx = db.transaction(LIBRARY_MANAGEMENT_STORES.shelves, 'readonly');
  const rows = await requestToPromise<Shelf[]>(tx.objectStore(LIBRARY_MANAGEMENT_STORES.shelves).getAll());
  await transactionDone(tx);
  return rows.sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'ko'));
}

export async function listLibraryShelfMemberships(): Promise<ShelfMembership[]> {
  const db = await openReaderDb();
  const tx = db.transaction(LIBRARY_MANAGEMENT_STORES.memberships, 'readonly');
  const rows = await requestToPromise<ShelfMembership[]>(
    tx.objectStore(LIBRARY_MANAGEMENT_STORES.memberships).getAll(),
  );
  await transactionDone(tx);
  return rows;
}

export async function createLibraryShelf(input: {
  readonly name: string;
  readonly color?: string;
}): Promise<ShelfMutationReceipt> {
  const name = shelfName(input.name);
  const color = shelfColor(input.color);
  const db = await openReaderDb();
  const tx = db.transaction([LIBRARY_MANAGEMENT_STORES.shelves, 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const done = transactionDone(tx);
  const rows = await requestToPromise<Shelf[]>(tx.objectStore(LIBRARY_MANAGEMENT_STORES.shelves).getAll());
  if (rows.some((row) => row.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('같은 이름의 책장이 이미 있습니다.');
  }
  const now = new Date().toISOString();
  const shelf: Shelf = {
    id: persistentId128('shelf', [name, now]),
    name,
    color,
    sortOrder: rows.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1,
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
  tx.objectStore(LIBRARY_MANAGEMENT_STORES.shelves).put(shelf);
  await queueSyncEventInTransaction(tx, 'shelf_updated', jsonValue({ shelf }), { entityId: shelf.id });
  await done;
  return { shelf, operation: 'created' };
}

export async function updateLibraryShelf(
  shelfId: string,
  patch: { readonly name?: string; readonly color?: string | null; readonly sortOrder?: number },
  expectedRevision?: number,
): Promise<ShelfMutationReceipt> {
  const db = await openReaderDb();
  const tx = db.transaction([LIBRARY_MANAGEMENT_STORES.shelves, 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(LIBRARY_MANAGEMENT_STORES.shelves);
  const current = await requestToPromise<Shelf | undefined>(store.get(shelfId));
  if (!current) {
    await done;
    throw new Error('책장을 찾을 수 없습니다.');
  }
  if (expectedRevision !== undefined && current.revision !== expectedRevision) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('다른 기기에서 책장이 변경되었습니다.');
  }
  const updatedAt = new Date().toISOString();
  const shelf: Shelf = {
    ...current,
    ...(patch.name === undefined ? undefined : { name: shelfName(patch.name) }),
    ...(patch.color === undefined ? undefined : { color: shelfColor(patch.color) }),
    ...(patch.sortOrder === undefined
      ? undefined
      : { sortOrder: Math.max(0, Math.min(10_000, Math.trunc(patch.sortOrder))) }),
    updatedAt,
    revision: current.revision + 1,
  };
  store.put(shelf);
  await queueSyncEventInTransaction(tx, 'shelf_updated', jsonValue({ shelf }), { entityId: shelf.id });
  await done;
  return { shelf, operation: 'updated' };
}

export async function deleteLibraryShelf(shelfId: string, expectedRevision?: number): Promise<ShelfMutationReceipt> {
  const db = await openReaderDb();
  const tx = db.transaction(
    [LIBRARY_MANAGEMENT_STORES.shelves, LIBRARY_MANAGEMENT_STORES.memberships, 'devices', 'sync_outbox', 'sync_state'],
    'readwrite',
  );
  const done = transactionDone(tx);
  const shelfStore = tx.objectStore(LIBRARY_MANAGEMENT_STORES.shelves);
  const shelf = await requestToPromise<Shelf | undefined>(shelfStore.get(shelfId));
  if (!shelf) {
    await done;
    throw new Error('책장을 찾을 수 없습니다.');
  }
  if (expectedRevision !== undefined && shelf.revision !== expectedRevision) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('다른 기기에서 책장이 변경되었습니다.');
  }
  shelfStore.delete(shelfId);
  const memberships = tx.objectStore(LIBRARY_MANAGEMENT_STORES.memberships).index('shelfId').openCursor(shelfId);
  memberships.onsuccess = () => {
    const cursor = memberships.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
  const deletedAt = new Date().toISOString();
  await queueSyncEventInTransaction(
    tx,
    'shelf_deleted',
    jsonValue({ shelfId, revision: shelf.revision + 1, deletedAt }),
    { entityId: shelfId },
  );
  await done;
  return { shelf: { ...shelf, revision: shelf.revision + 1, updatedAt: deletedAt }, operation: 'deleted' };
}

function membershipId(shelfId: string, bookId: string): string {
  return persistentId128('shelf_membership', [shelfId, bookId]);
}

export async function setLibraryShelfMembership(shelfId: string, bookId: string, included: boolean): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(
    [
      'novels',
      LIBRARY_MANAGEMENT_STORES.shelves,
      LIBRARY_MANAGEMENT_STORES.memberships,
      'devices',
      'sync_outbox',
      'sync_state',
    ],
    'readwrite',
  );
  const done = transactionDone(tx);
  const [shelf, book] = await Promise.all([
    requestToPromise<Shelf | undefined>(tx.objectStore(LIBRARY_MANAGEMENT_STORES.shelves).get(shelfId)),
    requestToPromise<Novel | undefined>(tx.objectStore('novels').get(bookId)),
  ]);
  if (!shelf || !book) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error(!shelf ? '책장을 찾을 수 없습니다.' : '책을 찾을 수 없습니다.');
  }
  const id = membershipId(shelfId, bookId);
  const store = tx.objectStore(LIBRARY_MANAGEMENT_STORES.memberships);
  if (included) {
    const membership: ShelfMembership = { id, shelfId, bookId, createdAt: new Date().toISOString() };
    store.put(membership);
    await queueSyncEventInTransaction(tx, 'shelf_membership_added', jsonValue({ membership }), {
      novelId: bookId,
      entityId: id,
    });
  } else {
    store.delete(id);
    await queueSyncEventInTransaction(
      tx,
      'shelf_membership_removed',
      jsonValue({ id, shelfId, bookId, removedAt: new Date().toISOString() }),
      { novelId: bookId, entityId: id },
    );
  }
  await done;
}

async function applyBatchTarget(
  command: BatchLibraryCommand,
  target: BatchLibraryTarget,
): Promise<BatchLibraryItemResult> {
  const novel = await getNovel(target.bookId);
  if (!novel) return { bookId: target.bookId, status: 'failed', reason: 'book_not_found' };
  try {
    if (command.kind === 'add_to_shelf' || command.kind === 'remove_from_shelf') {
      await setLibraryShelfMembership(command.shelfId, target.bookId, command.kind === 'add_to_shelf');
      return { bookId: target.bookId, status: 'applied', metadataRevision: novel.metadataRevision ?? 0 };
    }
    if (command.kind === 'add_tag' || command.kind === 'remove_tag') {
      const normalizedTag = command.tag.trim().replace(/\s+/g, ' ');
      const tags = novel.tags ?? [];
      const nextTags =
        command.kind === 'add_tag'
          ? [...tags, normalizedTag]
          : tags.filter((tag) => tag.toLocaleLowerCase() !== normalizedTag.toLocaleLowerCase());
      if (JSON.stringify(nextTags) === JSON.stringify(tags)) {
        return { bookId: target.bookId, status: 'skipped', metadataRevision: novel.metadataRevision ?? 0 };
      }
      const receipt = await patchLibraryBookMetadata(
        target.bookId,
        { tags: nextTags },
        target.expectedRevision,
        target.expectedContentRevisionId,
      );
      return { bookId: target.bookId, status: 'applied', metadataRevision: receipt.metadataRevision };
    }
    if (command.kind === 'set_favorite') {
      if (novel.favorite === command.favorite) {
        return { bookId: target.bookId, status: 'skipped', metadataRevision: novel.metadataRevision ?? 0 };
      }
      const receipt = await patchLibraryBookMetadata(
        target.bookId,
        { favorite: command.favorite },
        target.expectedRevision,
        target.expectedContentRevisionId,
      );
      return { bookId: target.bookId, status: 'applied', metadataRevision: receipt.metadataRevision };
    }
    const receipt =
      command.kind === 'move_to_trash'
        ? await moveNovelToTrash(target.bookId, {
            metadataRevision: target.expectedRevision,
            activeContentRevisionId: target.expectedContentRevisionId,
          })
        : await restoreNovelFromTrash(target.bookId, {
            metadataRevision: target.expectedRevision,
            activeContentRevisionId: target.expectedContentRevisionId,
          });
    return { bookId: target.bookId, status: 'applied', metadataRevision: receipt.metadataRevision };
  } catch (error) {
    return {
      bookId: target.bookId,
      status: 'failed',
      reason: error instanceof Error ? error.message : 'unknown_error',
    };
  }
}

export async function applyLibraryBatch(
  command: BatchLibraryCommand,
  targets: readonly BatchLibraryTarget[],
  idempotencyKey: string,
): Promise<BatchLibraryReceipt> {
  if (!idempotencyKey.trim()) throw new Error('idempotencyKey is required');
  if (targets.length === 0 || targets.length > 500) throw new Error('batch target count must be between 1 and 500');
  const db = await openReaderDb();
  const readTx = db.transaction(LIBRARY_MANAGEMENT_STORES.receipts, 'readonly');
  const existing = await requestToPromise<BatchLibraryReceipt | undefined>(
    readTx.objectStore(LIBRARY_MANAGEMENT_STORES.receipts).index('idempotencyKey').get(idempotencyKey),
  );
  await transactionDone(readTx);
  if (existing) return existing;
  const results: BatchLibraryItemResult[] = [];
  for (const target of targets) results.push(await applyBatchTarget(command, target));
  const createdAt = new Date().toISOString();
  const receipt: BatchLibraryReceipt = {
    id: persistentId128('library_batch_receipt', [idempotencyKey]),
    idempotencyKey,
    command,
    results,
    createdAt,
  };
  const writeTx = db.transaction(LIBRARY_MANAGEMENT_STORES.receipts, 'readwrite');
  writeTx.objectStore(LIBRARY_MANAGEMENT_STORES.receipts).put(receipt);
  await transactionDone(writeTx);
  return receipt;
}
