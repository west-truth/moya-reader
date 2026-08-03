import { persistentId128 } from '@noveldesk/text-core/hash';
import { DOCUMENT_LISTENING_STORES } from './document-listening-schema';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';

export interface StoredDocumentThumbnail {
  readonly id: string;
  readonly bookId: string;
  readonly pageIndex: number;
  readonly pageHash: string;
  readonly renderFingerprint: string;
  readonly contentType: 'image/jpeg' | 'image/webp';
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly byteLength: number;
  readonly blob: Blob;
  readonly createdAt: string;
  readonly lastAccessedAt: string;
}

function thumbnailId(bookId: string, pageIndex: number): string {
  return persistentId128('document_thumbnail', [bookId, String(pageIndex)]);
}

export async function getDocumentThumbnail(input: {
  readonly bookId: string;
  readonly pageIndex: number;
  readonly pageHash: string;
  readonly renderFingerprint: string;
  readonly now?: string;
  readonly touch?: boolean;
}): Promise<StoredDocumentThumbnail | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(DOCUMENT_LISTENING_STORES.documentThumbnailCache, 'readwrite');
  const store = tx.objectStore(DOCUMENT_LISTENING_STORES.documentThumbnailCache);
  const current = await requestToPromise<StoredDocumentThumbnail | undefined>(
    store.get(thumbnailId(input.bookId, input.pageIndex)),
  );
  if (!current) {
    await transactionDone(tx);
    return undefined;
  }
  if (current.pageHash !== input.pageHash || current.renderFingerprint !== input.renderFingerprint) {
    store.delete(current.id);
    await transactionDone(tx);
    return undefined;
  }
  if (input.touch === false) {
    await transactionDone(tx);
    return current;
  }
  const next = { ...current, lastAccessedAt: input.now ?? new Date().toISOString() };
  store.put(next);
  await transactionDone(tx);
  return next;
}

export async function saveDocumentThumbnail(input: {
  readonly bookId: string;
  readonly pageIndex: number;
  readonly pageHash: string;
  readonly renderFingerprint: string;
  readonly contentType: StoredDocumentThumbnail['contentType'];
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly blob: Blob;
  readonly now?: string;
}): Promise<StoredDocumentThumbnail> {
  const timestamp = input.now ?? new Date().toISOString();
  const record: StoredDocumentThumbnail = {
    id: thumbnailId(input.bookId, input.pageIndex),
    bookId: input.bookId,
    pageIndex: input.pageIndex,
    pageHash: input.pageHash,
    renderFingerprint: input.renderFingerprint,
    contentType: input.contentType,
    pixelWidth: input.pixelWidth,
    pixelHeight: input.pixelHeight,
    byteLength: input.blob.size,
    blob: input.blob,
    createdAt: timestamp,
    lastAccessedAt: timestamp,
  };
  const db = await openReaderDb();
  const tx = db.transaction(DOCUMENT_LISTENING_STORES.documentThumbnailCache, 'readwrite');
  tx.objectStore(DOCUMENT_LISTENING_STORES.documentThumbnailCache).put(record);
  await transactionDone(tx);
  return record;
}

export async function pruneDocumentThumbnails(
  bookId: string,
  maxItems = 5_000,
  maxBytes = 64 * 1024 * 1024,
): Promise<number> {
  const db = await openReaderDb();
  const tx = db.transaction(DOCUMENT_LISTENING_STORES.documentThumbnailCache, 'readwrite');
  const store = tx.objectStore(DOCUMENT_LISTENING_STORES.documentThumbnailCache);
  const limit = Math.max(0, Math.floor(maxItems));
  const count = await requestToPromise<number>(store.index('bookId').count(bookId));
  const rows = await requestToPromise<StoredDocumentThumbnail[]>(store.index('bookId').getAll(bookId));
  if (count <= limit && rows.reduce((total, row) => total + row.byteLength, 0) <= maxBytes) {
    await transactionDone(tx);
    return 0;
  }
  let retainedItems = 0;
  let retainedBytes = 0;
  const remove = rows
    .sort((left, right) => right.lastAccessedAt.localeCompare(left.lastAccessedAt))
    .filter((row) => {
      const keep = retainedItems < limit && retainedBytes + row.byteLength <= Math.max(0, maxBytes);
      if (keep) {
        retainedItems += 1;
        retainedBytes += row.byteLength;
      }
      return !keep;
    });
  remove.forEach((row) => store.delete(row.id));
  await transactionDone(tx);
  return remove.length;
}
