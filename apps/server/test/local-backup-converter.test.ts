import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexedDbBackupRepository } from '../../../src/storage/indexeddb-backup-repository';
import {
  resetReaderDbForTests,
  getChapters,
  getParagraphs,
  saveBookmark,
  saveReadingPosition,
} from '../../../src/storage/db';
import {
  runBrowserImportPipeline,
  runBrowserEpubImportPipeline,
  runBrowserFixedDocumentImportPipeline,
} from '../../../src/services/import/browser-import-pipeline';
import { convertLocalBackup } from '../src/services/local-backup-converter.js';
// The desktop fixture module is JavaScript and is also used by native smoke checks.
// @ts-expect-error JavaScript smoke fixtures do not publish TypeScript declarations.
import { epubFixture, pdfFixture } from '../../../scripts/desktop/embedded-format-fixtures.mjs';
import { BlobReader, BlobWriter, Uint8ArrayReader, ZipReader, ZipWriter } from '@zip.js/zip.js';
import { materializePdfImport } from '@noveldesk/fixed-document-core';
import { saveParsedNovelImport } from '../../../src/storage/db';
import { IndexedDbDocumentAnnotationRepository } from '../../../src/storage/document-annotation-store';

async function withAdditionalBookField(zip: Blob): Promise<Blob> {
  const reader = new ZipReader(new BlobReader(zip), { useWebWorkers: false });
  try {
    const files = new Map<string, Uint8Array>();
    for (const entry of await reader.getEntries()) {
      if ('getData' in entry && entry.getData)
        files.set(entry.filename, new Uint8Array(await (await entry.getData(new BlobWriter())).arrayBuffer()));
    }
    const path = 'stores/novels.json';
    const novels = JSON.parse(new TextDecoder().decode(files.get(path))) as Record<string, unknown>[];
    novels[0]!.unmappedFutureData = 'must survive';
    const changed = new TextEncoder().encode(JSON.stringify(novels));
    files.set(path, changed);
    const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json'))) as {
      entries: Array<{ path: string; byteLength: number; contentHash: string }>;
    };
    const entry = manifest.entries.find((item) => item.path === path)!;
    entry.byteLength = changed.byteLength;
    entry.contentHash = `sha256:${createHash('sha256').update(changed).digest('hex')}`;
    files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
    const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
    for (const [name, bytes] of files) await writer.add(name, new Uint8ArrayReader(bytes));
    return await writer.close();
  } finally {
    await reader.close();
  }
}

describe('local v1 backup conversion', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('maps an actual TXT backup, source bytes, position and bookmark to the hosted restore model', async () => {
    const bytes = new TextEncoder().encode('제1화 시작\n\n로컬 서재 문단입니다.');
    const imported = await runBrowserImportPipeline({
      jobId: 'local-conversion-proof',
      fileName: 'local.txt',
      buffer: bytes.buffer as ArrayBuffer,
      sourceBlob: new Blob([bytes], { type: 'text/plain' }),
      totalBytes: bytes.byteLength,
      encoding: 'utf-8',
      chapterSplitMode: 'mixed',
      onProgress: () => undefined,
      yieldControl: async () => undefined,
    });
    const [chapter] = await getChapters(imported.novel.id);
    const [paragraph] = await getParagraphs(chapter.id);
    await saveBookmark({
      id: 'bookmark_1',
      novelId: imported.novel.id,
      chapterId: chapter.id,
      paragraphId: paragraph.id,
      label: '이전할 위치',
      progress: 0.5,
      scrollTop: 24,
      createdAt: '2026-09-24T00:00:00.000Z',
    });
    await saveReadingPosition({
      novelId: imported.novel.id,
      chapterId: chapter.id,
      paragraphId: paragraph.id,
      paragraphIndex: paragraph.index,
      chapterProgress: 0.5,
      scrollTop: 24,
    });
    const { blob } = await new IndexedDbBackupRepository().exportBackup();
    const parsed = await convertLocalBackup(
      blob,
      'new_owner',
      `sha256:${createHash('sha256')
        .update(Buffer.from(await blob.arrayBuffer()))
        .digest('hex')}`,
    );
    expect(parsed.manifest.books).toEqual([expect.objectContaining({ id: imported.novel.id })]);
    expect(parsed.tables.get('library_books')).toEqual([
      expect.objectContaining({
        id: imported.novel.id,
        user_id: 'new_owner',
        active_content_revision_id: parsed.manifest.books[0].activeContentRevisionId,
      }),
    ]);
    expect(parsed.tables.get('reading_positions')).toEqual([
      expect.objectContaining({ book_id: imported.novel.id, chapter_id: chapter.id, user_id: 'new_owner' }),
    ]);
    expect(parsed.tables.get('bookmarks')).toEqual([
      expect.objectContaining({ id: 'bookmark_1', book_id: imported.novel.id, user_id: 'new_owner' }),
    ]);
    const source = parsed.assetBlobs.get(parsed.objects.find((item) => item.asset_kind === 'source')!.id);
    expect(source instanceof Blob ? Buffer.from(await source.arrayBuffer()) : source).toEqual(Buffer.from(bytes));
    await expect(convertLocalBackup(await withAdditionalBookField(blob), 'new_owner', 'sha256:test')).rejects.toThrow(
      'unmappedFutureData',
    );
  });

  it.each([
    ['epub', 'book.epub', async () => await epubFixture(), 'application/epub+zip'],
    ['pdf', 'book.pdf', async () => pdfFixture(), 'application/pdf'],
    [
      'image_archive',
      'book.cbz',
      async () => {
        const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
        const png = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        );
        await writer.add('001.png', new Uint8ArrayReader(png));
        return Buffer.from(await (await writer.close()).arrayBuffer());
      },
      'application/vnd.comicbook+zip',
    ],
  ] as const)('preserves %s source and embedded asset identities', async (format, fileName, fixture, contentType) => {
    const bytes = await fixture();
    let imported;
    if (format === 'pdf') {
      const parsed = await materializePdfImport({
        fileName,
        sourceBytes: new Uint8Array(bytes),
        now: '2026-09-24T00:00:00.000Z',
      });
      await saveParsedNovelImport(parsed, {
        sourceAsset: {
          blob: new Blob([bytes], { type: contentType }),
          fileName,
          contentType,
          contentHash: parsed.novel.rawTextHash,
        },
      });
      imported = parsed;
    } else {
      imported = await (format === 'epub' ? runBrowserEpubImportPipeline : runBrowserFixedDocumentImportPipeline)({
        jobId: `local-${format}`,
        fileName,
        buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        sourceBlob: new Blob([bytes], { type: contentType }),
        totalBytes: bytes.byteLength,
        encoding: 'auto',
        chapterSplitMode: 'auto',
        onProgress: () => undefined,
        yieldControl: async () => undefined,
      });
    }
    if (format === 'pdf') {
      await new IndexedDbDocumentAnnotationRepository().save({
        id: 'local_pdf_bookmark',
        bookId: imported.novel.id,
        pageIndex: 0,
        type: 'page_bookmark',
        anchor: {
          kind: 'fixed_page',
          bookId: imported.novel.id,
          pageIndex: 0,
          pageHash: `${imported.novel.rawTextHash}:pdf-page:0`,
        },
        createdAt: '2026-09-24T00:00:00.000Z',
        updatedAt: '2026-09-24T00:00:00.000Z',
      });
    }
    const { blob } = await new IndexedDbBackupRepository().exportBackup();
    const parsed = await convertLocalBackup(
      blob,
      'new_owner',
      `sha256:${createHash('sha256')
        .update(Buffer.from(await blob.arrayBuffer()))
        .digest('hex')}`,
    );
    expect(parsed.manifest.books).toEqual([expect.objectContaining({ id: imported.novel.id, format })]);
    const source = parsed.assetBlobs.get(parsed.objects.find((item) => item.asset_kind === 'source')!.id);
    expect(source instanceof Blob ? Buffer.from(await source.arrayBuffer()) : source).toEqual(bytes);
    if (format === 'image_archive') {
      expect(parsed.tables.get('book_assets')?.map((row) => row.kind)).toEqual(['cover', 'document_page']);
      expect(parsed.assetBlobs.size).toBe(3);
    }
    if (format === 'epub') expect(parsed.assetBlobs.size).toBe(1);
    if (format === 'pdf')
      expect(parsed.tables.get('document_annotations')).toEqual([
        expect.objectContaining({ id: 'local_pdf_bookmark', book_id: imported.novel.id }),
      ]);
  });
});
