import {
  BlobReader,
  BlobWriter,
  TextWriter,
  Uint8ArrayReader,
  ZipReader,
  ZipWriter,
  type FileEntry,
} from '@zip.js/zip.js';
import {
  materializeImageArchiveImport,
  materializeStreamingImageArchiveImport,
  openImageArchiveStream,
  parseImageArchive,
} from '@noveldesk/fixed-document-core';
import { describe, expect, it } from 'vitest';
import { buildSuwayomiSeriesArchive, type SuwayomiSeriesManifest } from './suwayomi-series-cbz';

const PNG_1X1 = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
);

async function chapterArchive(pageCount: number): Promise<Blob> {
  const output = new BlobWriter('application/vnd.comicbook+zip');
  const writer = new ZipWriter(output);
  for (let index = 0; index < pageCount; index += 1) {
    await writer.add(`${String(index + 1).padStart(3, '0')}.png`, new Uint8ArrayReader(PNG_1X1));
  }
  return writer.close();
}

async function manifest(file: Blob): Promise<SuwayomiSeriesManifest> {
  const reader = new ZipReader(new BlobReader(file));
  try {
    const entry = (await reader.getEntries()).find(
      (candidate): candidate is FileEntry =>
        !candidate.directory && candidate.filename === 'moya-series.json' && Boolean((candidate as FileEntry).getData),
    );
    if (!entry) throw new Error('manifest missing');
    return JSON.parse(await entry.getData!(new TextWriter())) as SuwayomiSeriesManifest;
  } finally {
    await reader.close();
  }
}

describe('Suwayomi series CBZ', () => {
  it('keeps releases in one archive and preserves stable page identity when another release is appended', async () => {
    const collection = { remoteId: 'manga:41', title: '연재 작품', author: '작가' };
    const first = await buildSuwayomiSeriesArchive({
      collection,
      chapters: [
        {
          remoteId: 'chapter:1',
          release: { title: '1화', chapterNumber: 1, sourceOrder: 1 },
          sourceContentHash: 'hash-1',
          file: await chapterArchive(2),
        },
      ],
      signal: new AbortController().signal,
    });
    const firstDocument = await parseImageArchive(first);
    const firstParsed = materializeImageArchiveImport({
      fileName: first.name,
      sourceBytes: new Uint8Array(await first.arrayBuffer()),
      document: firstDocument,
      clientBookId: 'series-book',
    });

    const second = await buildSuwayomiSeriesArchive({
      collection,
      existingArchive: first,
      chapters: [
        {
          remoteId: 'chapter:2',
          release: { title: '2화', chapterNumber: 2, sourceOrder: 2 },
          sourceContentHash: 'hash-2',
          file: await chapterArchive(1),
        },
      ],
      signal: new AbortController().signal,
    });
    const secondDocument = await parseImageArchive(second);
    const secondParsed = materializeImageArchiveImport({
      fileName: second.name,
      sourceBytes: new Uint8Array(await second.arrayBuffer()),
      document: secondDocument,
      clientBookId: 'series-book',
    });

    expect(await manifest(second)).toMatchObject({
      collection,
      chapters: [
        { remoteId: 'chapter:1', title: '1화', pageCount: 2 },
        { remoteId: 'chapter:2', title: '2화', pageCount: 1 },
      ],
    });
    expect(secondParsed.novel).toMatchObject({ title: '연재 작품', totalChapters: 3, documentSectionCount: 2 });
    expect(secondParsed.chapters.map((chapter) => chapter.documentSectionTitle)).toEqual(['1화', '1화', '2화']);
    expect(secondParsed.chapters.slice(0, 2).map((chapter) => chapter.id)).toEqual(
      firstParsed.chapters.map((chapter) => chapter.id),
    );

    const streamedDocument = await openImageArchiveStream(second, { fileName: second.name });
    const streamedParsed = materializeStreamingImageArchiveImport({
      fileName: second.name,
      sourceContentHash: 'aggregate-source-hash',
      document: streamedDocument,
      clientBookId: 'series-book',
    });
    expect(streamedParsed.chapters.map((chapter) => chapter.documentSectionTitle)).toEqual(['1화', '1화', '2화']);
  });

  it('can promote one legacy chapter archive without losing it', async () => {
    const legacy = await chapterArchive(1);
    const result = await buildSuwayomiSeriesArchive({
      collection: { remoteId: 'manga:41', title: '연재 작품' },
      existingArchive: legacy,
      existingLegacyChapter: {
        remoteId: 'chapter:1',
        release: { title: '1화', chapterNumber: 1 },
        sourceContentHash: 'legacy-hash',
      },
      chapters: [
        {
          remoteId: 'chapter:2',
          release: { title: '2화', chapterNumber: 2 },
          sourceContentHash: 'hash-2',
          file: await chapterArchive(1),
        },
      ],
      signal: new AbortController().signal,
    });

    expect((await manifest(result)).chapters.map((chapter) => chapter.remoteId)).toEqual(['chapter:1', 'chapter:2']);
  });
});
