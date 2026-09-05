import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDocumentSeriesArchive,
  DOCUMENT_SERIES_CONTENT_TYPE,
  REMOTE_DOCUMENT_IDENTITY_SCHEME,
  readDocumentSeriesArchive,
  type DocumentSeriesSourceInput,
} from '@noveldesk/document-series-core';
import { integrityHash } from '@noveldesk/text-core/hash';
import { IndexedDbBookAssetRepository } from '../repositories/indexeddb-book-asset-repository';
import { IndexedDbReaderRepository } from '../repositories/indexeddb-reader-repository';
import { runBrowserFixedDocumentImportPipeline } from '../services/import/browser-import-pipeline';
import type { BookContentRevisionRecord } from '../storage/content-revisions';
import { openBookContentRevision, openReaderDb, resetReaderDbForTests, searchBookParagraphs } from '../storage/db';

afterEach(() => resetReaderDbForTests());

async function source(id: string, title: string, body: string, order: number): Promise<DocumentSeriesSourceInput> {
  const blob = new Blob([body], { type: 'text/plain' });
  return {
    id,
    title,
    fileName: `작품 ${title}.txt`,
    contentType: 'text/plain',
    contentHash: integrityHash(new Uint8Array(await blob.arrayBuffer())),
    sourceOrder: order,
    format: 'txt',
    encoding: 'utf-8',
    chapterSplitMode: 'single',
    includedChapterIndices: [1],
    blob,
  };
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function activeRevisionStorage(bookId: string) {
  const db = await openReaderDb();
  const novel = await requestToPromise<{ activeContentRevisionId?: string } | undefined>(
    db.transaction('novels', 'readonly').objectStore('novels').get(bookId),
  );
  const revisionId = novel?.activeContentRevisionId;
  if (!revisionId) throw new Error('active content revision missing');
  const tx = db.transaction(
    [
      'book_content_revisions',
      'book_content_chapters',
      'book_content_paragraphs',
      'book_content_paragraph_pages',
      'book_content_paragraph_search',
    ],
    'readonly',
  );
  const [revision, chapterCount, paragraphCount, pageCount, searchRowCount] = await Promise.all([
    requestToPromise<BookContentRevisionRecord | undefined>(tx.objectStore('book_content_revisions').get(revisionId)),
    requestToPromise<number>(tx.objectStore('book_content_chapters').index('contentRevisionId').count(revisionId)),
    requestToPromise<number>(tx.objectStore('book_content_paragraphs').index('contentRevisionId').count(revisionId)),
    requestToPromise<number>(
      tx.objectStore('book_content_paragraph_pages').index('contentRevisionId').count(revisionId),
    ),
    requestToPromise<number>(
      tx.objectStore('book_content_paragraph_search').index('contentRevisionId').count(revisionId),
    ),
  ]);
  return { revisionId, revision, chapterCount, paragraphCount, pageCount, searchRowCount };
}

describe('browser document-series import', () => {
  it('round-trips remote schema 2 through stored source export and a different book identity without changing source bytes', async () => {
    const sources = [
      {
        ...(await source('remote-release-1', '원격 1화', '\ufeff# 제목\r\n\r\n\u00a0  첫 문단  \r\n\r\n끝  ', 1)),
        extractionVersion: 'utf8-txt-v1',
      },
      {
        ...(await source('remote-release-2', '원격 2화', '\ufeff1장\r\n\r\n두 번째 본문\r\n', 2)),
        extractionVersion: 'utf8-txt-v1',
      },
    ];
    const aggregate = await buildDocumentSeriesArchive({
      collection: { id: 'portable-remote-series', title: '원격 원본 보존', format: 'txt' },
      identityScheme: REMOTE_DOCUMENT_IDENTITY_SCHEME,
      sources,
    });
    const importSource = (bookId: string, blob: Blob, fileName: string) =>
      runBrowserFixedDocumentImportPipeline({
        jobId: `portable-${bookId}`,
        fileName,
        buffer: new ArrayBuffer(0),
        sourceBlob: blob,
        totalBytes: blob.size,
        encoding: 'auto',
        clientBookId: bookId,
        expectedBase: { kind: 'absent' },
        onProgress: () => undefined,
        yieldControl: async () => undefined,
      });
    await importSource('remote-original', aggregate, aggregate.name);
    const reader = new IndexedDbReaderRepository();
    const assets = new IndexedDbBookAssetRepository();
    const exported = await assets.exportSource('remote-original');
    expect(exported?.metadata.contentType).toBe(DOCUMENT_SERIES_CONTENT_TYPE);
    expect(await exported!.blob.arrayBuffer()).toEqual(await aggregate.arrayBuffer());
    const originalPackage = (await readDocumentSeriesArchive(exported!.blob))!;
    expect(originalPackage.manifest).toMatchObject({
      schemaVersion: 2,
      identityScheme: REMOTE_DOCUMENT_IDENTITY_SCHEME,
      collection: { id: 'portable-remote-series', format: 'txt' },
    });

    await importSource('remote-restored', exported!.blob, exported!.metadata.fileName ?? aggregate.name);
    const restored = await assets.exportSource('remote-restored');
    expect(restored?.metadata.contentType).toBe(DOCUMENT_SERIES_CONTENT_TYPE);
    expect(await restored!.blob.arrayBuffer()).toEqual(await exported!.blob.arrayBuffer());
    const restoredPackage = (await readDocumentSeriesArchive(restored!.blob))!;
    expect(restoredPackage.manifest).toEqual(originalPackage.manifest);
    for (const input of sources) {
      const expectedBytes = new Uint8Array(await input.blob.arrayBuffer());
      expect(new Uint8Array(await originalPackage.sources.get(input.id)!.arrayBuffer())).toEqual(expectedBytes);
      expect(new Uint8Array(await restoredPackage.sources.get(input.id)!.arrayBuffer())).toEqual(expectedBytes);
    }

    const originalChapters = await reader.listChapters('remote-original');
    const restoredChapters = await reader.listChapters('remote-restored');
    expect(originalChapters).toHaveLength(2);
    expect(restoredChapters).toHaveLength(2);
    for (const [index, chapter] of restoredChapters.entries()) {
      const original = originalChapters[index]!;
      expect(chapter).toMatchObject({
        novelId: 'remote-restored',
        title: original.title,
        documentSectionId: sources[index]!.id,
        documentSectionTitle: original.documentSectionTitle,
        documentSectionIndex: original.documentSectionIndex,
        documentSectionSourceContentHash: sources[index]!.contentHash,
      });
      // Chapters are book-scoped; the portable remote section identity survives across books.
      expect(chapter.id).not.toBe(original.id);
      expect(chapter.documentSectionId).toBe(original.documentSectionId);
      const oldPage = await reader.getParagraphPage(original.id, 0);
      const newPage = await reader.getParagraphPage(chapter.id, 0);
      expect(newPage?.paragraphs.map((paragraph) => paragraph.text)).toEqual(
        oldPage?.paragraphs.map((paragraph) => paragraph.text),
      );
      expect(newPage!.paragraphs.every((paragraph) => paragraph.chapterId === chapter.id)).toBe(true);
    }
    expect((await reader.getNovel('remote-restored'))?.documentSectionCount).toBe(2);
  });

  it('stores a TXT source bundle as one Library work through the normal atomic pipeline', async () => {
    const aggregate = await buildDocumentSeriesArchive({
      collection: { id: 'local-series', title: '작품', format: 'txt' },
      sources: [
        await source('source-1', '1화', '첫 번째 본문입니다.', 1),
        await source('source-2', '2화', '두 번째 본문입니다.', 2),
      ],
    });
    await runBrowserFixedDocumentImportPipeline({
      jobId: 'document-series-import',
      fileName: aggregate.name,
      buffer: new ArrayBuffer(0),
      sourceBlob: aggregate,
      totalBytes: aggregate.size,
      encoding: 'auto',
      clientBookId: 'local-series-book',
      onProgress: () => undefined,
      yieldControl: async () => undefined,
    });

    const reader = new IndexedDbReaderRepository();
    const assets = new IndexedDbBookAssetRepository();
    const stored = await reader.getNovel('local-series-book');
    const chapters = await reader.listChapters('local-series-book');
    const exported = await assets.exportSource('local-series-book');

    expect(stored).toMatchObject({ format: 'txt', title: '작품', totalChapters: 2 });
    expect(chapters.map((chapter) => chapter.title)).toEqual(['1화', '2화']);
    expect(exported?.metadata.contentType).toBe(DOCUMENT_SERIES_CONTENT_TYPE);
    expect((await readDocumentSeriesArchive(exported!.blob))?.manifest.sources).toHaveLength(2);
  });

  it('appends only new document-series chapters while existing reads remain pinned', async () => {
    const sources = [
      await source('source-1', '1화', '첫 번째 본문입니다.', 1),
      await source('source-2', '2화', '두 번째 본문입니다.', 2),
    ];
    const initial = await buildDocumentSeriesArchive({
      collection: { id: 'local-series-append', title: '증분 작품', format: 'txt' },
      sources,
    });
    await runBrowserFixedDocumentImportPipeline({
      jobId: 'document-series-initial',
      fileName: initial.name,
      buffer: new ArrayBuffer(0),
      sourceBlob: initial,
      totalBytes: initial.size,
      encoding: 'auto',
      clientBookId: 'local-series-append-book',
      onProgress: () => undefined,
      yieldControl: async () => undefined,
    });
    const pinned = await openBookContentRevision('local-series-append-book');
    const before = await activeRevisionStorage('local-series-append-book');

    const appended = await buildDocumentSeriesArchive({
      collection: { id: 'local-series-append', title: '증분 작품', format: 'txt' },
      sources: [...sources, await source('source-3', '3화', '세 번째 신규 본문입니다.', 3)],
    });
    await runBrowserFixedDocumentImportPipeline({
      jobId: 'document-series-append',
      fileName: appended.name,
      buffer: new ArrayBuffer(0),
      sourceBlob: appended,
      totalBytes: appended.size,
      encoding: 'auto',
      clientBookId: 'local-series-append-book',
      onProgress: () => undefined,
      yieldControl: async () => undefined,
    });

    const reader = new IndexedDbReaderRepository();
    const assets = new IndexedDbBookAssetRepository();
    const after = await activeRevisionStorage('local-series-append-book');
    expect(after.revision).toMatchObject({
      status: 'active',
      actual: { chapterCount: 1, paragraphCount: 1, paragraphRefCount: 1, searchRowCount: 1 },
      composition: {
        kind: 'append_delta',
        componentRevisionIds: [before.revisionId, after.revisionId],
        logicalCounts: { chapterCount: 3, paragraphCount: 3 },
      },
    });
    expect(after).toMatchObject({ chapterCount: 1, paragraphCount: 0, pageCount: 1, searchRowCount: 0 });
    expect((await pinned.listChapters()).map((chapter) => chapter.title)).toEqual(['1화', '2화']);
    expect((await reader.listChapters('local-series-append-book')).map((chapter) => chapter.title)).toEqual([
      '1화',
      '2화',
      '3화',
    ]);
    expect(await searchBookParagraphs('local-series-append-book', '첫 번째', 5)).toHaveLength(1);
    expect(await searchBookParagraphs('local-series-append-book', '세 번째 신규', 5)).toHaveLength(1);
    expect(
      (await readDocumentSeriesArchive((await assets.exportSource('local-series-append-book'))!.blob))?.manifest
        .sources,
    ).toHaveLength(3);

    const interrupted = await buildDocumentSeriesArchive({
      collection: { id: 'local-series-append', title: '증분 작품', format: 'txt' },
      sources: [
        ...sources,
        await source('source-3', '3화', '세 번째 신규 본문입니다.', 3),
        await source('source-4', '4화', '저장되면 안 되는 본문입니다.', 4),
      ],
    });
    await expect(
      runBrowserFixedDocumentImportPipeline({
        jobId: 'document-series-interrupted-append',
        fileName: interrupted.name,
        buffer: new ArrayBuffer(0),
        sourceBlob: interrupted,
        totalBytes: interrupted.size,
        encoding: 'auto',
        clientBookId: 'local-series-append-book',
        onProgress: (progress) => {
          if (progress.subphase === 'writing_pages') throw new Error('forced append interruption');
        },
        yieldControl: async () => undefined,
      }),
    ).rejects.toThrow('forced append interruption');
    expect((await activeRevisionStorage('local-series-append-book')).revisionId).toBe(after.revisionId);
    expect(
      (await readDocumentSeriesArchive((await assets.exportSource('local-series-append-book'))!.blob))?.manifest
        .sources,
    ).toHaveLength(3);
  });

  it('falls back to a full revision when the existing text prefix identity changed', async () => {
    const initial = await buildDocumentSeriesArchive({
      collection: { id: 'local-series-rewritten-prefix', title: '개정 작품', format: 'txt' },
      sources: [await source('source-1', '1화', '같은 첫 번째 본문입니다.', 1)],
    });
    await runBrowserFixedDocumentImportPipeline({
      jobId: 'document-series-prefix-initial',
      fileName: initial.name,
      buffer: new ArrayBuffer(0),
      sourceBlob: initial,
      totalBytes: initial.size,
      encoding: 'auto',
      clientBookId: 'local-series-rewritten-prefix-book',
      onProgress: () => undefined,
      yieldControl: async () => undefined,
    });

    const revised = await buildDocumentSeriesArchive({
      collection: { id: 'local-series-rewritten-prefix', title: '개정 작품', format: 'txt' },
      sources: [
        await source('source-1', '개정 1화', '같은 첫 번째 본문입니다.', 1),
        await source('source-2', '2화', '두 번째 신규 본문입니다.', 2),
      ],
    });
    await runBrowserFixedDocumentImportPipeline({
      jobId: 'document-series-prefix-reimport',
      fileName: revised.name,
      buffer: new ArrayBuffer(0),
      sourceBlob: revised,
      totalBytes: revised.size,
      encoding: 'auto',
      clientBookId: 'local-series-rewritten-prefix-book',
      onProgress: () => undefined,
      yieldControl: async () => undefined,
    });

    const stored = await activeRevisionStorage('local-series-rewritten-prefix-book');
    expect(stored.revision?.composition).toBeUndefined();
    expect(stored).toMatchObject({ chapterCount: 2, paragraphCount: 0, pageCount: 2, searchRowCount: 0 });
    expect(
      (await new IndexedDbReaderRepository().listChapters('local-series-rewritten-prefix-book')).map(
        (chapter) => chapter.title,
      ),
    ).toEqual(['개정 1화', '2화']);
  });
});
