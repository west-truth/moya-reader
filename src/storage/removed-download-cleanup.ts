import type { Novel } from '../domain/types';
import { BOOK_ASSET_STORES, type StoredBookAsset } from './book-asset-schema';
import { CONTENT_REVISION_STORES } from './content-revision-migration';
import { contentRevisionComponentIds, type BookContentRevisionRecord } from './content-revisions';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';

/** Explicit download removal also releases superseded bytes, without touching live/staging revisions or covers. */
export async function cleanupRemovedDownloads(bookId: string, expectedRevision: string): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(
    ['novels', ...Object.values(CONTENT_REVISION_STORES), BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs],
    'readwrite',
  );
  const done = transactionDone(tx);
  const novel = await requestToPromise<Novel | undefined>(tx.objectStore('novels').get(bookId));
  if (novel?.activeContentRevisionId !== expectedRevision) {
    await done;
    return;
  }
  const revisions = await requestToPromise<BookContentRevisionRecord[]>(
    tx.objectStore(CONTENT_REVISION_STORES.revisions).index('novelId').getAll(bookId),
  );
  const protectedIds = new Set(
    revisions
      .filter((revision) => revision.status !== 'superseded')
      .flatMap((revision) => [
        ...contentRevisionComponentIds(revision),
        ...(revision.status === 'staging' && revision.baseActiveRevisionId ? [revision.baseActiveRevisionId] : []),
      ]),
  );
  const removedIds = new Set(
    revisions
      .filter((revision) => revision.status === 'superseded' && !protectedIds.has(revision.id))
      .map((revision) => revision.id),
  );
  for (const id of removedIds) {
    for (const name of [
      CONTENT_REVISION_STORES.chapters,
      CONTENT_REVISION_STORES.paragraphs,
      CONTENT_REVISION_STORES.pages,
      CONTENT_REVISION_STORES.search,
    ]) {
      const request = tx.objectStore(name).index('contentRevisionId').openCursor(IDBKeyRange.only(id));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    }
    tx.objectStore(CONTENT_REVISION_STORES.revisions).delete(id);
  }
  const assets = tx.objectStore(BOOK_ASSET_STORES.assets);
  const records = await requestToPromise<StoredBookAsset[]>(assets.index('bookId').getAll(bookId));
  const keys = new Set<string>();
  for (const asset of records) {
    if (
      asset.status !== 'superseded' ||
      asset.kind === 'cover' ||
      (asset.contentRevisionId && protectedIds.has(asset.contentRevisionId))
    )
      continue;
    assets.delete(asset.id);
    keys.add(asset.storageKey);
  }
  for (const key of keys) {
    if ((await requestToPromise(assets.index('storageKey').count(key))) === 0)
      tx.objectStore(BOOK_ASSET_STORES.blobs).delete(key);
  }
  await done;
}
