import { expect, it } from 'vitest';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { assertLargeArchiveSupported, localUploadLimit, MAX_LOCAL_ARCHIVE_BYTES } from './local-archive-policy.js';

it('only raises standalone EPUB/ZIP/CBZ uploads, respects archive overrides and caps at 4GiB', () => {
  const config = { maxUploadBytes: 500 * 1024 ** 2, maxArchiveUploadBytes: MAX_LOCAL_ARCHIVE_BYTES };
  for (const name of ['book.epub', 'book.CBZ', 'book.zip']) expect(localUploadLimit(config, name)).toBe(4 * 1024 ** 3);
  for (const name of ['book.pdf', 'book.rar', 'book.7z', 'book.txt'])
    expect(localUploadLimit(config, name)).toBe(config.maxUploadBytes);
  expect(localUploadLimit(config, 'book.cbz', 'append_local_archive')).toBe(MAX_LOCAL_ARCHIVE_BYTES);
  expect(localUploadLimit(config, 'book.cbz', 'append_image_series')).toBe(config.maxUploadBytes);
  expect(localUploadLimit({ ...config, maxArchiveUploadBytes: 1024 }, 'book.epub')).toBe(1024);
  expect(localUploadLimit({ ...config, maxArchiveUploadBytes: 8 * 1024 ** 3 }, 'book.epub')).toBe(
    MAX_LOCAL_ARCHIVE_BYTES,
  );
});
it('rejects eager restore containers and disguised archives before reading their contents', async () => {
  const signal = new AbortController().signal;
  await expect(assertLargeArchiveSupported(new Blob(['Rar!']), 'book.cbz', 1, signal)).rejects.toThrow('EPUB·ZIP·CBZ');
  for (const name of ['moya-comic-source.cbz', 'moya-document-series.json']) {
    const writer = new ZipWriter(new BlobWriter());
    await writer.add(name, new TextReader('{}'));
    await expect(assertLargeArchiveSupported(await writer.close(), 'book.zip', 1, signal)).rejects.toThrow('내보내기');
  }
});
