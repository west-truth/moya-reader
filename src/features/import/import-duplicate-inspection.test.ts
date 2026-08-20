import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '../../domain/hash';
import type { Novel } from '../../domain/types';
import { inspectImportDuplicates, MAX_IMPORT_DUPLICATE_HASH_BYTES } from './import-duplicate-inspection';

function novel(overrides: Partial<Novel> = {}): Novel {
  return {
    id: 'book-1',
    title: '기존 책',
    sourceFileName: 'book.txt',
    sourceEncoding: 'utf-8',
    rawText: '본문',
    normalizedText: '본문',
    rawTextHash: 'hash',
    normalizedTextHash: 'hash',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    totalChapters: 1,
    totalCharacters: 2,
    totalParagraphs: 1,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
    ...overrides,
  };
}

describe('inspectImportDuplicates', () => {
  it('uses a content hash for small files to find the same source', async () => {
    const file = new File(['같은 본문'], 'renamed.txt', { type: 'text/plain' });
    const rawTextHash = await sha256(await file.arrayBuffer());

    await expect(inspectImportDuplicates([file], [novel({ rawTextHash })])).resolves.toEqual([
      expect.objectContaining({ kind: 'same_source', policy: 'open_existing', sourceHash: rawTextHash }),
    ]);
  });

  it('does not copy a large file into memory before upload and only checks its file name', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const file = {
      name: 'book.txt',
      size: MAX_IMPORT_DUPLICATE_HASH_BYTES + 1,
      lastModified: 1,
      type: 'text/plain',
      arrayBuffer,
    } as unknown as File;

    await expect(inspectImportDuplicates([file], [novel()])).resolves.toEqual([
      expect.objectContaining({ kind: 'same_name', policy: 'new', sourceHash: undefined }),
    ]);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
