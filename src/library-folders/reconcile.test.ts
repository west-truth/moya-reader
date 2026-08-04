import { describe, expect, it } from 'vitest';
import type { Novel } from '../domain/types';
import { DEFAULT_LIBRARY_FOLDER_FILTER, type LinkedLibraryFolder, type StoredLibraryFolderEntry } from './contracts';
import { reconcileLibraryFolderScan } from './reconcile';

const folder: LinkedLibraryFolder = {
  id: 'folder-1',
  providerKind: 'browser-directory',
  displayName: 'Books',
  filter: DEFAULT_LIBRARY_FOLDER_FILTER,
  autoSync: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function novel(id: string, sourceFileName: string): Novel {
  return {
    id,
    sourceFileName,
    title: sourceFileName,
    rawText: '',
    normalizedText: '',
    rawTextHash: id,
    normalizedTextHash: id,
    createdAt: folder.createdAt,
    updatedAt: folder.createdAt,
    totalChapters: 1,
    totalCharacters: 1,
    totalParagraphs: 1,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
  };
}

function stored(overrides: Partial<StoredLibraryFolderEntry> = {}): StoredLibraryFolderEntry {
  return {
    id: 'folder-1::old.txt',
    folderId: 'folder-1',
    sourceKey: 'old.txt',
    relativePath: 'old.txt',
    fileName: 'old.txt',
    byteLength: 100,
    lastModified: 10,
    signature: 'old.txt\u0000100\u000010',
    bookId: 'book-1',
    status: 'linked',
    firstSeenAt: folder.createdAt,
    lastSeenAt: folder.createdAt,
    ...overrides,
  };
}

describe('reconcileLibraryFolderScan', () => {
  it('separates changed, new, filtered, and missing files', () => {
    const result = reconcileLibraryFolderScan({
      folder,
      sourceEntries: [
        { sourceKey: 'old.txt', relativePath: 'old.txt', fileName: 'old.txt', byteLength: 101, lastModified: 11 },
        { sourceKey: 'new.epub', relativePath: 'new.epub', fileName: 'new.epub', byteLength: 200, lastModified: 12 },
        { sourceKey: 'image.png', relativePath: 'image.png', fileName: 'image.png', byteLength: 10, lastModified: 12 },
      ],
      storedEntries: [stored(), stored({ id: 'folder-1::gone.txt', sourceKey: 'gone.txt', relativePath: 'gone.txt' })],
      novels: [novel('book-1', 'old.txt')],
      scannedAt: '2026-08-01T01:00:00.000Z',
    });
    expect(result.candidates.map((candidate) => candidate.status)).toEqual([
      'changed',
      'new',
      'unsupported',
      'missing',
    ]);
  });

  it('tracks a unique rename without treating it as a new book', () => {
    const result = reconcileLibraryFolderScan({
      folder,
      sourceEntries: [
        {
          sourceKey: 'renamed.txt',
          relativePath: 'renamed.txt',
          fileName: 'renamed.txt',
          byteLength: 100,
          lastModified: 10,
        },
      ],
      storedEntries: [stored()],
      novels: [novel('book-1', 'old.txt')],
      scannedAt: '2026-08-01T01:00:00.000Z',
    });
    expect(result.candidates[0]).toMatchObject({ status: 'unchanged', bookId: 'book-1' });
    expect(result.retiredEntryIds).toEqual(['folder-1::old.txt']);
  });
});
