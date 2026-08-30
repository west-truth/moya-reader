import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';
import {
  buildSeriesImageArchive,
  mergeSeriesImageArchiveDelta,
  readSeriesImageArchiveManifest,
  type SeriesImageArchiveManifest,
  type SeriesImageChapterInput,
  type SeriesImageCollection,
} from './series-image-archive';

const PNG_1X1 = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
);

async function chapterArchive(pageCount = 1): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
  for (let index = 0; index < pageCount; index += 1) {
    await writer.add(`${String(index + 1).padStart(3, '0')}.png`, new Uint8ArrayReader(PNG_1X1));
  }
  return writer.close();
}

async function chapter(
  remoteId: string,
  sourceContentHash: string,
  chapterNumber: number,
  pageCount = 1,
  title = `${chapterNumber}화`,
): Promise<SeriesImageChapterInput> {
  return {
    remoteId,
    release: { title, chapterNumber, sourceOrder: chapterNumber },
    remoteRevision: `revision:${sourceContentHash}`,
    sourceContentHash,
    file: await chapterArchive(pageCount),
  };
}

async function series(collection: SeriesImageCollection, chapters: readonly SeriesImageChapterInput[]): Promise<File> {
  return buildSeriesImageArchive({ collection, chapters, signal: new AbortController().signal });
}

async function archiveWithManifest(manifest: unknown, pages: readonly string[] = []): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
  for (const page of pages) await writer.add(page, new Uint8ArrayReader(PNG_1X1));
  await writer.add('moya-series.json', new TextReader(JSON.stringify(manifest)));
  return writer.close();
}

describe('series image archive delta merge', () => {
  const collection = { remoteId: 'manga:41', title: '연재 작품', author: '작가' };

  it('keeps unchanged sections and applies added or changed sections in one merged archive', async () => {
    const existing = await series(collection, [
      await chapter('chapter:1', 'hash-1', 1),
      await chapter('chapter:2', 'hash-2-old', 2),
    ]);
    const delta = await series({ ...collection, description: '갱신된 작품 설명' }, [
      await chapter('chapter:1', 'sha256:HASH-1', 1, 2, '무시할 동일 본문 제목'),
      await chapter('chapter:2', 'hash-2-new', 2, 2, '2화 개정'),
      await chapter('chapter:3', 'hash-3', 3),
    ]);

    const result = await mergeSeriesImageArchiveDelta({
      existingArchive: existing,
      deltaArchive: delta,
      signal: new AbortController().signal,
    });
    const manifest = await readSeriesImageArchiveManifest(result.file);

    expect(result.changedSectionIds).toEqual(['chapter:2', 'chapter:3']);
    expect(result.replacedSectionIds).toEqual(['chapter:2']);
    expect(result.addedSectionIds).toEqual(['chapter:3']);
    expect(result.unchangedSectionIds).toEqual(['chapter:1']);
    expect(manifest?.collection).toEqual({ ...collection, description: '갱신된 작품 설명' });
    expect(manifest?.chapters).toMatchObject([
      { remoteId: 'chapter:1', title: '1화', sourceContentHash: 'hash-1', pageCount: 1 },
      { remoteId: 'chapter:2', title: '2화 개정', sourceContentHash: 'hash-2-new', pageCount: 2 },
      { remoteId: 'chapter:3', title: '3화', sourceContentHash: 'hash-3', pageCount: 1 },
    ]);
  });

  it('returns the existing File without rewriting when every delta section has the same source hash', async () => {
    const existing = await series(collection, [await chapter('chapter:1', 'hash-1', 1)]);
    const delta = await series(collection, [await chapter('chapter:1', 'SHA256:HASH-1', 1, 2, '바뀐 메타데이터')]);

    const result = await mergeSeriesImageArchiveDelta({
      existingArchive: existing,
      deltaArchive: delta,
      signal: new AbortController().signal,
    });

    expect(result.file).toBe(existing);
    expect(result.changedSectionIds).toEqual([]);
    expect(result.replacedSectionIds).toEqual([]);
    expect(result.addedSectionIds).toEqual([]);
    expect(result.unchangedSectionIds).toEqual(['chapter:1']);
    expect((await readSeriesImageArchiveManifest(result.file))?.chapters[0]).toMatchObject({
      title: '1화',
      sourceContentHash: 'hash-1',
      pageCount: 1,
    });
  });

  it('keeps replacement intent when a stale base no longer contains the release', async () => {
    const existing = await series(collection, [await chapter('chapter:2', 'hash-2', 2)]);
    const replacement = await chapter('chapter:1', 'hash-1-new', 1);
    const delta = await buildSeriesImageArchive({
      collection,
      targetBookId: 'book-1',
      chapters: [{ ...replacement, expectedPreviousSourceContentHash: 'hash-1-old' }],
      signal: new AbortController().signal,
    });

    const result = await mergeSeriesImageArchiveDelta({
      existingArchive: existing,
      deltaArchive: delta,
      targetBookId: 'book-1',
      signal: new AbortController().signal,
    });

    expect(result.replacedSectionIds).toEqual(['chapter:1']);
    expect(result.addedSectionIds).toEqual([]);
  });

  it('rejects a replacement when the current release hash differs from its expected base', async () => {
    const existing = await series(collection, [await chapter('chapter:1', 'hash-1-newer', 1)]);
    const replacement = await chapter('chapter:1', 'hash-1-stale', 1);
    const delta = await buildSeriesImageArchive({
      collection,
      targetBookId: 'book-1',
      chapters: [{ ...replacement, expectedPreviousSourceContentHash: 'hash-1-old' }],
      signal: new AbortController().signal,
    });

    await expect(
      mergeSeriesImageArchiveDelta({
        existingArchive: existing,
        deltaArchive: delta,
        targetBookId: 'book-1',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/예상한 기존 회차 본문/u);
  });

  it('rejects a delta from another collection before rewriting the aggregate', async () => {
    const existing = await series(collection, [await chapter('chapter:1', 'hash-1', 1)]);
    const delta = await series({ remoteId: 'manga:99', title: '다른 작품' }, [await chapter('chapter:2', 'hash-2', 2)]);

    await expect(
      mergeSeriesImageArchiveDelta({
        existingArchive: existing,
        deltaArchive: delta,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/collection identity/u);
  });

  it('rejects a manifest whose declared pages are missing from the delta archive', async () => {
    const existing = await series(collection, [await chapter('chapter:1', 'hash-1', 1)]);
    const invalidManifest: SeriesImageArchiveManifest = {
      schemaVersion: 1,
      collection,
      chapters: [
        {
          remoteId: 'chapter:2',
          title: '2화',
          chapterNumber: 2,
          sourceContentHash: 'hash-2',
          pageCount: 1,
          entryNames: ['chapters/000001/00001.png'],
        },
      ],
    };
    const delta = await archiveWithManifest(invalidManifest);

    await expect(
      mergeSeriesImageArchiveDelta({
        existingArchive: existing,
        deltaArchive: delta,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/manifest.*페이지 목록/u);
  });

  it('rejects duplicate section identities inside a delta manifest', async () => {
    const existing = await series(collection, [await chapter('chapter:1', 'hash-1', 1)]);
    const delta = await archiveWithManifest(
      {
        schemaVersion: 1,
        collection,
        chapters: [
          {
            remoteId: 'chapter:2',
            title: '2화',
            sourceContentHash: 'hash-2',
            pageCount: 1,
            entryNames: ['a.png'],
          },
          {
            remoteId: 'chapter:2',
            title: '2화 사본',
            sourceContentHash: 'hash-2',
            pageCount: 1,
            entryNames: ['b.png'],
          },
        ],
      },
      ['a.png', 'b.png'],
    );

    await expect(
      mergeSeriesImageArchiveDelta({
        existingArchive: existing,
        deltaArchive: delta,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/중복 회차/u);
  });

  it('rejects an oversized manifest before decompressing its JSON payload', async () => {
    const existing = await series(collection, [await chapter('chapter:1', 'hash-1', 1)]);
    const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
    await writer.add('chapter-2.png', new Uint8ArrayReader(PNG_1X1));
    await writer.add(
      'moya-series.json',
      new TextReader(
        JSON.stringify({
          schemaVersion: 1,
          collection: { ...collection, description: 'x'.repeat(4 * 1024 * 1024) },
          chapters: [
            {
              remoteId: 'chapter:2',
              title: '2화',
              sourceContentHash: 'hash-2',
              pageCount: 1,
              entryNames: ['chapter-2.png'],
            },
          ],
        }),
      ),
      { level: 9 },
    );
    const delta = await writer.close();

    await expect(
      mergeSeriesImageArchiveDelta({
        existingArchive: existing,
        deltaArchive: delta,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/manifest 크기.*안전 한도/u);
  });

  it('rejects an extreme manifest compression ratio before decompression', async () => {
    const existing = await series(collection, [await chapter('chapter:1', 'hash-1', 1)]);
    const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
    await writer.add('chapter-2.png', new Uint8ArrayReader(PNG_1X1));
    await writer.add(
      'moya-series.json',
      new TextReader(
        JSON.stringify({
          schemaVersion: 1,
          collection: { ...collection, description: 'x'.repeat(1024 * 1024) },
          chapters: [
            {
              remoteId: 'chapter:2',
              title: '2화',
              sourceContentHash: 'hash-2',
              pageCount: 1,
              entryNames: ['chapter-2.png'],
            },
          ],
        }),
      ),
      { level: 9 },
    );
    const delta = await writer.close();

    await expect(
      mergeSeriesImageArchiveDelta({
        existingArchive: existing,
        deltaArchive: delta,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/manifest 압축률.*안전 한도/u);
  });

  it('validates an existing manifest archive before rebuilding it', async () => {
    const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
    await writer.add('chapters/000001/00001.png', new TextReader('x'.repeat(1024 * 1024)), { level: 9 });
    await writer.add(
      'moya-series.json',
      new TextReader(
        JSON.stringify({
          schemaVersion: 1,
          collection,
          chapters: [
            {
              remoteId: 'chapter:1',
              title: '1화',
              sourceContentHash: 'hash-1',
              pageCount: 1,
              entryNames: ['chapters/000001/00001.png'],
            },
          ],
        }),
      ),
    );
    const unsafeExisting = await writer.close();

    await expect(
      buildSeriesImageArchive({
        collection,
        chapters: [await chapter('chapter:2', 'hash-2', 2)],
        existingArchive: unsafeExisting,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/페이지 압축률.*안전 한도/u);
  });

  it('keeps the manifest-free legacy chapter rebuild path', async () => {
    const rebuilt = await buildSeriesImageArchive({
      collection,
      chapters: [await chapter('chapter:2', 'hash-2', 2)],
      existingArchive: await chapterArchive(),
      existingLegacyChapter: {
        remoteId: 'chapter:1',
        release: { title: '1화', chapterNumber: 1, sourceOrder: 1 },
        sourceContentHash: 'hash-1',
      },
      signal: new AbortController().signal,
    });

    expect((await readSeriesImageArchiveManifest(rebuilt))?.chapters).toMatchObject([
      { remoteId: 'chapter:1', sourceContentHash: 'hash-1' },
      { remoteId: 'chapter:2', sourceContentHash: 'hash-2' },
    ]);
  });

  it('rejects empty page payloads before extracting a delta archive', async () => {
    const existing = await series(collection, [await chapter('chapter:1', 'hash-1', 1)]);
    const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
    await writer.add('empty.png', new Uint8ArrayReader(new Uint8Array()));
    await writer.add(
      'moya-series.json',
      new TextReader(
        JSON.stringify({
          schemaVersion: 1,
          collection,
          chapters: [
            {
              remoteId: 'chapter:2',
              title: '2화',
              sourceContentHash: 'hash-2',
              pageCount: 1,
              entryNames: ['empty.png'],
            },
          ],
        }),
      ),
    );
    const delta = await writer.close();

    await expect(
      mergeSeriesImageArchiveDelta({
        existingArchive: existing,
        deltaArchive: delta,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/페이지 크기.*안전 한도/u);
  });

  it('rejects archives padded with excessive unrelated central-directory entries', async () => {
    const existing = await series(collection, [await chapter('chapter:1', 'hash-1', 1)]);
    const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
    for (let index = 0; index < 6_000; index += 1) {
      await writer.add(`padding/${index}.bin`, new Uint8ArrayReader(Uint8Array.of(index % 251)), { level: 0 });
    }
    await writer.add(
      'moya-series.json',
      new TextReader(JSON.stringify({ schemaVersion: 1, collection, chapters: [] })),
    );
    const delta = await writer.close();

    await expect(
      mergeSeriesImageArchiveDelta({
        existingArchive: existing,
        deltaArchive: delta,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/압축 항목 수.*안전 한도/u);
  });
});
