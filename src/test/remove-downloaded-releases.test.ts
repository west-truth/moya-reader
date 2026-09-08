import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import {
  buildDocumentSeriesArchive,
  readDocumentSeriesArchive,
  REMOTE_DOCUMENT_IDENTITY_SCHEME,
} from '@noveldesk/document-series-core';
import { integrityHash } from '@noveldesk/text-core/hash';
import { buildComicRemovalDelta, readComicSourceManifest } from '@noveldesk/fixed-document-core/comic-source';
import { removeDownloadedReleases } from '../external-sources/series/remove-downloaded-releases';
import { IndexedDbReaderRepository } from '../repositories/indexeddb-reader-repository';
import { IndexedDbBookAssetRepository } from '../repositories/indexeddb-book-asset-repository';
import { runBrowserFixedDocumentImportPipeline } from '../services/import/browser-import-pipeline';
import { buildSeriesImageArchive } from '../services/import/series-image-archive';
import type { ImportFileInput, ImportService } from '../services/import/import-service';
import { getActiveComicAssetMetadata } from '../storage/book-asset-store';
import { openReaderDb, resetReaderDbForTests } from '../storage/db';

afterEach(() => resetReaderDbForTests());
const reader = new IndexedDbReaderRepository();
const assets = new IndexedDbBookAssetRepository();
const importService: ImportService = {
  supportsExpectedBase: true,
  supportsIncrementalImageSeriesAppend: true,
  importFile(input: ImportFileInput) {
    return {
      jobId: 'removal-test',
      cancel() {},
      promise: runBrowserFixedDocumentImportPipeline({
        ...input,
        jobId: 'removal-test',
        fileName: input.file.name,
        sourceBlob: input.file,
        buffer: new ArrayBuffer(0),
        totalBytes: input.file.size,
        onProgress() {},
        yieldControl: async () => {},
      }),
    };
  },
};
async function remove(bookId: string, sectionIds: string[]) {
  return removeDownloadedReleases({ bookId, sectionIds, assets, importService, getNovel: (id) => reader.getNovel(id) });
}
async function txtSources() {
  return Promise.all(
    [1, 2, 3].map(async (n) => {
      const blob = new Blob([`chapter ${n}\r\n  preserved bytes ${n}  `]);
      return {
        id: `release-${n}`,
        title: `Chapter ${n}`,
        fileName: `${n}.txt`,
        contentType: 'text/plain',
        contentHash: integrityHash(new Uint8Array(await blob.arrayBuffer())),
        sourceOrder: n,
        format: 'txt' as const,
        encoding: 'utf-8' as const,
        chapterSplitMode: 'single' as const,
        includedChapterIndices: [1],
        blob,
      };
    }),
  );
}
async function textArchive(sources: Awaited<ReturnType<typeof txtSources>>) {
  return buildDocumentSeriesArchive({
    collection: { id: 'text-work', title: 'Text work', format: 'txt' },
    identityScheme: REMOTE_DOCUMENT_IDENTITY_SCHEME,
    sources,
  });
}
const png = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
);
async function addComic(n: number) {
  const writer = new ZipWriter(new BlobWriter());
  await writer.add(`${n}.png`, new Uint8ArrayReader(png));
  const file = await buildSeriesImageArchive({
    collection: { remoteId: 'comic-work', title: 'Comic' },
    chapters: [
      {
        remoteId: `chapter:${n}`,
        release: { title: `Chapter ${n}`, sourceOrder: n },
        sourceContentHash: `fixture-${n}`,
        file: await writer.close(),
      },
    ],
    signal: new AbortController().signal,
  });
  const current = await reader.getNovel('comic');
  return importService.importFile(
    {
      file,
      clientBookId: 'comic',
      encoding: 'auto',
      importMode: current ? 'append_image_series' : 'replace_book',
      baseActiveContentRevisionId: current?.activeContentRevisionId,
    },
    () => {},
  ).promise;
}

describe('downloaded release removal through the real storage pipeline', () => {
  it('removes selected TXT bytes, preserves remaining anchors, allows an empty book and re-download', async () => {
    const sources = await txtSources();
    await importService.importFile(
      { file: await textArchive(sources), clientBookId: 'text', encoding: 'utf-8' },
      () => {},
    ).promise;
    const cover = await assets.saveCover('text', {
      blob: new Blob([png]),
      fileName: 'cover.png',
      contentType: 'image/png',
      contentHash: integrityHash(png),
      pixelWidth: 1,
      pixelHeight: 1,
      fit: 'contain',
      positionX: 50,
      positionY: 50,
    });
    const chapters = await reader.listChapters('text');
    const survivor = chapters[1]!;
    const page = await reader.getParagraphPage(survivor.id, 0);
    await reader.saveReadingPosition({
      novelId: 'text',
      chapterId: survivor.id,
      paragraphId: page!.paragraphs[0]!.id,
      paragraphIndex: 0,
      scrollTop: 0,
      chapterProgress: 0.2,
      documentSectionId: survivor.documentSectionId,
    });
    await remove('text', ['release-1', 'release-3']);
    expect((await reader.listChapters('text')).map((value) => value.id)).toEqual([survivor.id]);
    expect((await reader.getReadingPosition('text'))?.chapterId).toBe(survivor.id);
    const remaining = await readDocumentSeriesArchive((await assets.exportSource('text'))!.blob);
    expect([...remaining!.sources.keys()]).toEqual(['release-2']);
    expect(await remaining!.sources.get('release-2')!.arrayBuffer()).toEqual(await sources[1]!.blob.arrayBuffer());
    await remove('text', ['release-2']);
    expect(await reader.listChapters('text')).toEqual([]);
    expect(await reader.getNovel('text')).toMatchObject({ id: 'text', totalChapters: 0, documentSectionCount: 0 });
    expect((await assets.getActiveCover('text'))?.metadata.id).toBe(cover.id);
    const empty = await reader.getNovel('text');
    await importService.importFile(
      {
        file: await textArchive([sources[1]!]),
        clientBookId: 'text',
        encoding: 'utf-8',
        expectedBase: { kind: 'revision', contentRevisionId: empty!.activeContentRevisionId! },
      },
      () => {},
    ).promise;
    expect((await reader.listChapters('text'))[0]?.id).toBe(survivor.id);
  });

  it('removes comic parts/pages without reading remaining originals, keeps page IDs, then re-downloads an empty book', async () => {
    await addComic(1);
    await addComic(2);
    await addComic(3);
    const chapters = await reader.listChapters('comic');
    const survivor = chapters[1]!;
    const page = await reader.getParagraphPage(survivor.id, 0);
    await reader.saveReadingPosition({
      novelId: 'comic',
      chapterId: survivor.id,
      documentSectionId: 'chapter:2',
      paragraphId: page!.paragraphs[0]!.id,
      paragraphIndex: 0,
      scrollTop: 0,
      chapterProgress: 0.2,
    });
    await remove('comic', ['chapter:1', 'chapter:3']);
    expect((await reader.listChapters('comic')).map((value) => value.id)).toEqual([survivor.id]);
    expect((await reader.getReadingPosition('comic'))?.chapterId).toBe(survivor.id);
    expect((await assets.getEmbeddedResource('comic', page!.paragraphs[0]!.assetId!))?.blob.size).toBe(png.length);
    const active = await getActiveComicAssetMetadata('comic');
    expect(active.filter((value) => value.kind === 'document_page')).toHaveLength(1);
    expect(active.filter((value) => value.kind === 'source_part')).toHaveLength(1);
    await remove('comic', ['chapter:2']);
    expect(await reader.listChapters('comic')).toEqual([]);
    expect(await getActiveComicAssetMetadata('comic')).toEqual([]);
    const db = await openReaderDb();
    const request = db
      .transaction('book_assets', 'readonly')
      .objectStore('book_assets')
      .index('bookId')
      .getAll('comic');
    const storedAssets = await new Promise<Array<{ kind: string }>>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(storedAssets.filter((asset) => asset.kind === 'source_part' || asset.kind === 'document_page')).toEqual([]);
    expect((await readComicSourceManifest((await assets.exportSource('comic'))!.blob))?.sourceParts).toEqual([]);
    await addComic(2);
    expect((await reader.listChapters('comic'))[0]?.id).toBe(survivor.id);
  });

  it('rejects a stale comic deletion instead of removing newer downloaded content', async () => {
    await addComic(1);
    const before = await reader.getNovel('comic');
    await addComic(2);
    await expect(
      importService.importFile(
        {
          file: await buildComicRemovalDelta('comic', ['chapter:1']),
          clientBookId: 'comic',
          encoding: 'auto',
          importMode: 'append_image_series',
          baseActiveContentRevisionId: before!.activeContentRevisionId,
        },
        () => {},
      ).promise,
    ).rejects.toThrow();
    expect(await reader.listChapters('comic')).toHaveLength(2);
  });
  it('removes the first legacy comic download and can download it again', async () => {
    await addComic(1);
    await remove('comic', ['chapter:1']);
    expect(await reader.listChapters('comic')).toEqual([]);
    await addComic(1);
    expect(await reader.listChapters('comic')).toHaveLength(1);
  });
});
