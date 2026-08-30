import 'fake-indexeddb/auto';
import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { afterEach, describe, expect, it } from 'vitest';
import { integrityHash } from '@noveldesk/text-core/hash';
import { IndexedDbBookAssetRepository } from '../repositories/indexeddb-book-asset-repository';
import { IndexedDbReaderRepository } from '../repositories/indexeddb-reader-repository';
import { runBrowserFixedDocumentImportPipeline } from '../services/import/browser-import-pipeline';
import {
  buildSeriesImageArchive,
  readSeriesImageArchiveManifest,
  type SeriesImageChapterInput,
} from '../services/import/series-image-archive';
import { openReaderDb, resetReaderDbForTests } from '../storage/db';

const PNG_1X1 = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
);

afterEach(() => resetReaderDbForTests());

async function release(remoteId: string, order: number, pageName = '001.png'): Promise<SeriesImageChapterInput> {
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
  await writer.add(pageName, new Uint8ArrayReader(PNG_1X1));
  const file = new File([await writer.close()], `${order}화.cbz`, {
    type: 'application/vnd.comicbook+zip',
  });
  return {
    remoteId,
    release: { title: `${order}화`, chapterNumber: order, sourceOrder: order },
    sourceContentHash: integrityHash(new Uint8Array(await file.arrayBuffer())),
    file,
  };
}

async function archive(
  chapters: readonly SeriesImageChapterInput[],
  options: { readonly remoteId?: string; readonly title?: string; readonly targetBookId?: string } = {},
): Promise<File> {
  return buildSeriesImageArchive({
    collection: {
      remoteId: options.remoteId ?? 'local_series_fixture',
      title: options.title ?? '증분 만화',
    },
    targetBookId: options.targetBookId,
    chapters,
    signal: new AbortController().signal,
  });
}

function pipelineInput(file: File, bookId: string) {
  return {
    jobId: `job-${file.name}`,
    fileName: file.name,
    buffer: new ArrayBuffer(0),
    sourceBlob: file,
    totalBytes: file.size,
    encoding: 'auto' as const,
    clientBookId: bookId,
    onProgress: () => undefined,
    yieldControl: async () => undefined,
  };
}

async function activeDocumentPageCount(bookId: string): Promise<number> {
  const db = await openReaderDb();
  const request = db
    .transaction('book_assets', 'readonly')
    .objectStore('book_assets')
    .index('bookId_kind_status')
    .count([bookId, 'document_page', 'active']);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function activeDocumentPages(
  bookId: string,
): Promise<Array<{ id: string; contentRevisionId?: string; status: string }>> {
  const db = await openReaderDb();
  const request = db
    .transaction('book_assets', 'readonly')
    .objectStore('book_assets')
    .index('bookId_kind_status')
    .getAll([bookId, 'document_page', 'active']);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe('browser image-series incremental import', () => {
  it('verifies expected source hashes on the full fallback path', async () => {
    const initial = await archive([await release('local_series_release_1', 1)]);
    await expect(
      runBrowserFixedDocumentImportPipeline({
        ...pipelineInput(initial, 'source-hash-mismatch-book'),
        expectedSourceContentHash: 'not-the-source-hash',
      }),
    ).rejects.toThrow('원본의 식별자');
    expect(await new IndexedDbReaderRepository().getNovel('source-hash-mismatch-book')).toBeUndefined();
  });

  it('merges only the delta input while preserving the canonical source and cover', async () => {
    const bookId = 'local-image-series-book';
    const initial = await archive([await release('local_series_release_1', 1)]);
    await runBrowserFixedDocumentImportPipeline(pipelineInput(initial, bookId));

    const reader = new IndexedDbReaderRepository();
    const assets = new IndexedDbBookAssetRepository();
    const before = (await reader.getNovel(bookId))!;
    const beforeCover = await assets.getActiveCover(bookId);
    expect(beforeCover).toBeDefined();
    const delta = await archive([await release('local_series_release_2', 2)]);
    const deltaHash = integrityHash(new Uint8Array(await delta.arrayBuffer()));

    await runBrowserFixedDocumentImportPipeline({
      ...pipelineInput(delta, bookId),
      importMode: 'append_image_series',
      baseActiveContentRevisionId: before.activeContentRevisionId,
      expectedSourceContentHash: deltaHash,
    });

    const after = (await reader.getNovel(bookId))!;
    const afterCover = await assets.getActiveCover(bookId);
    const exported = (await assets.exportSource(bookId))!;
    const manifest = await readSeriesImageArchiveManifest(exported.blob);
    expect(manifest?.chapters.map((chapter) => chapter.remoteId)).toEqual([
      'local_series_release_1',
      'local_series_release_2',
    ]);
    expect(new Set((await reader.listChapters(bookId)).map((chapter) => chapter.documentSectionId))).toEqual(
      new Set(['local_series_release_1', 'local_series_release_2']),
    );
    expect(after.activeContentRevisionId).not.toBe(before.activeContentRevisionId);
    expect(after.sourceContentHash).not.toBe(before.sourceContentHash);
    expect(afterCover?.metadata.id).toBe(beforeCover?.metadata.id);
    expect(afterCover?.metadata.contentHash).toBe(beforeCover?.metadata.contentHash);
    expect(await activeDocumentPageCount(bookId)).toBe(2);

    const revisionAfterAppend = after.activeContentRevisionId;
    await runBrowserFixedDocumentImportPipeline({
      ...pipelineInput(delta, bookId),
      importMode: 'append_image_series',
      baseActiveContentRevisionId: revisionAfterAppend,
      expectedSourceContentHash: deltaHash,
    });
    expect((await reader.getNovel(bookId))?.activeContentRevisionId).toBe(revisionAfterAppend);
  });

  it('retries concurrent delta appends so both chapters survive without leaking active pages', async () => {
    const bookId = 'local-image-series-concurrent-book';
    const initial = await archive([await release('local_series_release_1', 1)]);
    await runBrowserFixedDocumentImportPipeline(pipelineInput(initial, bookId));

    const reader = new IndexedDbReaderRepository();
    const assets = new IndexedDbBookAssetRepository();
    const before = (await reader.getNovel(bookId))!;
    const beforeCover = await assets.getActiveCover(bookId);
    const [secondChapter, thirdChapter] = await Promise.all([
      archive([await release('local_series_release_2', 2)]),
      archive([await release('local_series_release_3', 3)]),
    ]);

    // Both append operations reach the fixed-document replacement boundary only
    // after reading and merging the same active snapshot. One activation must
    // therefore lose the CAS race and exercise the bounded retry path.
    let fixedPasses = 0;
    let releaseFirstPasses: (() => void) | undefined;
    const firstPassesReady = new Promise<void>((resolve) => {
      releaseFirstPasses = resolve;
    });
    const synchronizeFirstFixedPasses = async () => {
      fixedPasses += 1;
      if (fixedPasses === 2) releaseFirstPasses?.();
      if (fixedPasses <= 2) await firstPassesReady;
    };
    const append = async (delta: File) =>
      runBrowserFixedDocumentImportPipeline({
        ...pipelineInput(delta, bookId),
        importMode: 'append_image_series',
        baseActiveContentRevisionId: before.activeContentRevisionId,
        expectedSourceContentHash: integrityHash(new Uint8Array(await delta.arrayBuffer())),
        yieldControl: synchronizeFirstFixedPasses,
      });

    await Promise.all([append(secondChapter), append(thirdChapter)]);

    const after = (await reader.getNovel(bookId))!;
    const afterCover = await assets.getActiveCover(bookId);
    const exported = (await assets.exportSource(bookId))!;
    const manifest = await readSeriesImageArchiveManifest(exported.blob);
    const pages = await activeDocumentPages(bookId);
    expect(fixedPasses).toBeGreaterThanOrEqual(3);
    expect(manifest?.chapters.map((chapter) => chapter.remoteId)).toEqual([
      'local_series_release_1',
      'local_series_release_2',
      'local_series_release_3',
    ]);
    expect(new Set((await reader.listChapters(bookId)).map((chapter) => chapter.documentSectionId))).toEqual(
      new Set(['local_series_release_1', 'local_series_release_2', 'local_series_release_3']),
    );
    expect(afterCover?.metadata.id).toBe(beforeCover?.metadata.id);
    expect(afterCover?.metadata.contentHash).toBe(beforeCover?.metadata.contentHash);
    expect(pages).toHaveLength(3);
    expect(new Set(pages.map((page) => page.id))).toHaveLength(3);
    expect(pages.every((page) => page.contentRevisionId === after.activeContentRevisionId)).toBe(true);
  });

  it('allows a stale-base new section but rejects a stale replacement of the same section', async () => {
    const bookId = 'local-image-series-section-conflict-book';
    const sectionId = 'local_series_release_1';
    const initial = await archive([await release(sectionId, 1, 'initial.png')]);
    await runBrowserFixedDocumentImportPipeline(pipelineInput(initial, bookId));
    const reader = new IndexedDbReaderRepository();
    const base = (await reader.getNovel(bookId))!;
    const updated = await archive([await release(sectionId, 1, 'updated.png')]);

    await runBrowserFixedDocumentImportPipeline({
      ...pipelineInput(updated, bookId),
      importMode: 'append_image_series',
      baseActiveContentRevisionId: base.activeContentRevisionId,
      expectedSourceContentHash: integrityHash(new Uint8Array(await updated.arrayBuffer())),
    });
    const afterUpdate = (await reader.getNovel(bookId))!;
    const staleReplacement = await archive([await release(sectionId, 1, 'stale.png')]);

    await expect(
      runBrowserFixedDocumentImportPipeline({
        ...pipelineInput(staleReplacement, bookId),
        importMode: 'append_image_series',
        baseActiveContentRevisionId: base.activeContentRevisionId,
        expectedSourceContentHash: integrityHash(new Uint8Array(await staleReplacement.arrayBuffer())),
      }),
    ).rejects.toMatchObject({ name: 'ContentRevisionConflictError' });
    expect((await reader.getNovel(bookId))?.activeContentRevisionId).toBe(afterUpdate.activeContentRevisionId);

    const newSection = await archive([await release('local_series_release_2', 2)]);
    await expect(
      runBrowserFixedDocumentImportPipeline({
        ...pipelineInput(newSection, bookId),
        importMode: 'append_image_series',
        baseActiveContentRevisionId: base.activeContentRevisionId,
        expectedSourceContentHash: integrityHash(new Uint8Array(await newSection.arrayBuffer())),
      }),
    ).resolves.toMatchObject({ novel: { id: bookId } });
  });

  it('rejects a replacement staged from a stale aggregate revision', async () => {
    const bookId = 'local-image-series-stale-book';
    const initial = await archive([await release('local_series_release_1', 1)]);
    await runBrowserFixedDocumentImportPipeline(pipelineInput(initial, bookId));
    const before = await new IndexedDbReaderRepository().getNovel(bookId);
    const replacement = await archive([
      await release('local_series_release_1', 1),
      await release('local_series_release_2', 2),
    ]);

    await expect(
      runBrowserFixedDocumentImportPipeline({
        ...pipelineInput(replacement, bookId),
        expectedBaseActiveContentRevisionId: 'stale-revision',
        preserveExistingEmbeddedAssets: true,
      }),
    ).rejects.toMatchObject({ name: 'ContentRevisionConflictError' });
    expect((await new IndexedDbReaderRepository().getNovel(bookId))?.activeContentRevisionId).toBe(
      before?.activeContentRevisionId,
    );
  });

  it('keeps the canonical collection identity after the Library title was edited', async () => {
    const bookId = 'renamed-local-image-series';
    const initial = await archive([await release('local_series_release_1', 1)], {
      remoteId: 'collection-before-title-edit',
      title: '원래 제목',
    });
    await runBrowserFixedDocumentImportPipeline(pipelineInput(initial, bookId));
    const reader = new IndexedDbReaderRepository();
    await reader.patchNovelMetadata(bookId, { title: '사용자가 바꾼 제목' });
    const before = (await reader.getNovel(bookId))!;
    const delta = await archive([await release('local_series_release_2', 2)], {
      remoteId: 'title-derived-identity-after-edit',
      title: '사용자가 바꾼 제목',
      targetBookId: bookId,
    });

    await runBrowserFixedDocumentImportPipeline({
      ...pipelineInput(delta, bookId),
      importMode: 'append_image_series',
      baseActiveContentRevisionId: before.activeContentRevisionId,
      expectedSourceContentHash: integrityHash(new Uint8Array(await delta.arrayBuffer())),
    });

    const stored = (await reader.getNovel(bookId))!;
    const source = (await new IndexedDbBookAssetRepository().exportSource(bookId))!;
    expect(stored.title).toBe('사용자가 바꾼 제목');
    expect(await readSeriesImageArchiveManifest(source.blob)).toMatchObject({
      collection: { remoteId: 'collection-before-title-edit', title: '원래 제목' },
      chapters: [{ remoteId: 'local_series_release_1' }, { remoteId: 'local_series_release_2' }],
    });
  });
});
