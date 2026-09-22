import type { LibraryStorageUsage, Novel, BookAssetMetadata } from '../domain/types';
import { BOOK_ASSET_STORES } from './book-asset-schema';
import { openReaderDb } from './reader-database';
import { requestToPromise, transactionDone } from './indexeddb-transaction';

export function summarizeLibraryStorage(
  books: readonly Novel[],
  assets: readonly BookAssetMetadata[],
): LibraryStorageUsage {
  const byBook = new Map(books.map((book) => [book.id, new Map<string, number>()]));
  const files = new Map<string, { bytes: number; trashOnly: boolean }>();
  const activeBooks = new Set(books.filter((book) => !book.deletedAt).map((book) => book.id));
  for (const asset of assets) {
    const bookFiles = byBook.get(asset.bookId);
    if (!bookFiles || asset.status !== 'active') continue;
    bookFiles.set(asset.storageKey, Math.max(bookFiles.get(asset.storageKey) ?? 0, asset.byteLength));
    const previous = files.get(asset.storageKey);
    files.set(asset.storageKey, {
      bytes: Math.max(previous?.bytes ?? 0, asset.byteLength),
      trashOnly: (previous?.trashOnly ?? true) && !activeBooks.has(asset.bookId),
    });
  }
  let libraryBytes = 0;
  let trashBytes = 0;
  for (const file of files.values()) {
    if (file.trashOnly) trashBytes += file.bytes;
    else libraryBytes += file.bytes;
  }
  return {
    books: books.map((book) => ({
      id: book.id,
      title: book.title,
      metadataRevision: book.metadataRevision ?? 0,
      trashed: Boolean(book.deletedAt),
      bytes: [...byBook.get(book.id)!.values()].reduce((a, b) => a + b, 0),
    })),
    totalBytes: libraryBytes + trashBytes,
    libraryBytes,
    trashBytes,
  };
}

export async function readLibraryStorageUsage(): Promise<LibraryStorageUsage> {
  const db = await openReaderDb();
  const tx = db.transaction(['novels', BOOK_ASSET_STORES.assets], 'readonly');
  const done = transactionDone(tx);
  const [books, assets] = await Promise.all([
    requestToPromise<Novel[]>(tx.objectStore('novels').getAll()),
    requestToPromise<BookAssetMetadata[]>(tx.objectStore(BOOK_ASSET_STORES.assets).index('status').getAll('active')),
  ]);
  await done;
  return summarizeLibraryStorage(books, assets);
}
