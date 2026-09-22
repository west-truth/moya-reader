import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { BookAssetMetadata, Novel } from '../domain/types';
import { summarizeLibraryStorage, readLibraryStorageUsage } from './library-storage-usage';
import { openReaderDb } from './reader-database';
import { transactionDone } from './indexeddb-transaction';

const books = [
  { id: 'active', title: '책', metadataRevision: 3 },
  { id: 'trash', title: '휴지통', deletedAt: '2026-09-22' },
] as Novel[];
const asset = (bookId: string, storageKey: string, byteLength: number, status = 'active') =>
  ({
    id: `${bookId}-${storageKey}-${status}`,
    bookId,
    storageKey,
    byteLength,
    status,
  }) as BookAssetMetadata;
const assets = [
  asset('active', 'shared', 2 * 1024 ** 3),
  asset('trash', 'shared', 2 * 1024 ** 3),
  asset('trash', 'only-trash', 100),
  asset('active', 'old', 999, 'superseded'),
  asset('missing', 'orphan', 999),
  asset('active', 'staged', 999, 'staged'),
];

describe('library storage usage', () => {
  it('deduplicates shared files and assigns shared live/trash files to the live library', () => {
    const result = summarizeLibraryStorage(books, [...assets, assets[0]]);
    expect(result.totalBytes).toBe(2 * 1024 ** 3 + 100);
    expect(result.libraryBytes).toBe(2 * 1024 ** 3);
    expect(result.trashBytes).toBe(100);
    expect(result.books.map((b) => b.bytes)).toEqual([2 * 1024 ** 3, 2 * 1024 ** 3 + 100]);
  });
  it('reads local metadata without requiring any stored blobs', async () => {
    const db = await openReaderDb();
    const tx = db.transaction(['novels', 'book_assets'], 'readwrite');
    const done = transactionDone(tx);
    books.forEach((b) => tx.objectStore('novels').put(b));
    assets.forEach((a) => tx.objectStore('book_assets').put(a));
    await done;
    expect(await readLibraryStorageUsage()).toEqual(summarizeLibraryStorage(books, assets));
  });
});
