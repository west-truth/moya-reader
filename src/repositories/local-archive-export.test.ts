import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { expect, it, vi } from 'vitest';
import { LOCAL_ARCHIVE_SERIES_TYPE } from '@noveldesk/document-series-core';
import type { BookAssetRepository } from './book-asset-repository';
import { exportPortableBookSource } from './comic-source-export';

it('exports ordered originals by hash after a hosted backup copy; bounds browser export before fetching parts', async () => {
  const sources = [1, 2].map((i) => ({
    assetId: `old-asset-${i}`,
    fileName: 'chapter.epub',
    contentHash: `sha256:${String(i).repeat(64)}`,
    byteLength: 3,
    contentType: 'application/epub+zip',
  }));
  const index = { version: 1, bookId: 'old-book', format: 'epub', sources };
  const getComicSourcePart = vi.fn(async (_bookId, hash) => ({
    metadata: { kind: 'source_part', contentHash: hash },
    blob: new Blob(['raw']),
  }));
  const assets = {
    exportSource: async () => ({
      blob: new Blob([JSON.stringify(index)]),
      metadata: { contentType: LOCAL_ARCHIVE_SERIES_TYPE },
    }),
    getComicSourcePart,
  } as unknown as BookAssetRepository;
  const exported = await exportPortableBookSource(assets, 'copied-book');
  expect(exported!.metadata.fileName).toBe('original-files.zip');
  const zip = new ZipReader(new BlobReader(exported!.blob));
  try {
    const entries = (await zip.getEntries()).filter((e) => !e.directory);
    expect(entries.map((e) => e.filename)).toEqual(['0001/chapter.epub', '0002/chapter.epub']);
    for (const entry of entries)
      expect(new TextDecoder().decode(await entry.getData!(new Uint8ArrayWriter()))).toBe('raw');
  } finally {
    await zip.close();
  }
  expect(getComicSourcePart).toHaveBeenCalledWith('copied-book', sources[0].contentHash);
  getComicSourcePart.mockClear();
  sources[0].byteLength = 1024 ** 3;
  await expect(exportPortableBookSource(assets, 'copied-book')).rejects.toThrow('내보내기');
  expect(getComicSourcePart).not.toHaveBeenCalled();
});
