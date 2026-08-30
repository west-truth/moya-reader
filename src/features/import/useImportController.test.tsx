import { BlobReader, BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Novel } from '../../domain/types';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { ImportService } from '../../services/import/import-service';
import { inspectDocumentSeriesSource, materializeDocumentSeriesArchive } from '@noveldesk/document-series-core';
import { integrityHash } from '@noveldesk/text-core/hash';
import { stableId } from '../../domain/hash';
import { readLocalSeriesManifest } from './local-series-import';
import { useImportController, type ImportFeatureController } from './useImportController';

const PNG_1X1 = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
);

async function chapter(name: string): Promise<File> {
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
  await writer.add('001.png', new Uint8ArrayReader(PNG_1X1));
  return new File([await writer.close()], name, { type: 'application/vnd.comicbook+zip' });
}

async function packageFile(): Promise<File> {
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  await writer.add('001.cbz', new BlobReader(await chapter('001.cbz')));
  await writer.add('002.cbz', new BlobReader(await chapter('002.cbz')));
  return new File([await writer.close()], '서른의 봄.zip', { type: 'application/zip' });
}

async function documentPackageFile(): Promise<File> {
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  await writer.add('회차/압축 작품 1화.txt', new Uint8ArrayReader(new TextEncoder().encode('제1화\n\n첫 본문')));
  await writer.add('회차/압축 작품 2화.txt', new Uint8ArrayReader(new TextEncoder().encode('제2화\n\n둘째 본문')));
  return new File([await writer.close()], '압축 작품 1권.zip', { type: 'application/zip' });
}

describe('useImportController local series analysis', () => {
  it('prefers a text document bundle over image-archive analysis for an outer ZIP', async () => {
    let controller!: ImportFeatureController;
    function Harness() {
      controller = useImportController({
        importService: { importFile: vi.fn() },
        getNovel: vi.fn(async () => undefined),
        listNovels: vi.fn(async () => []),
        listChapters: vi.fn(async () => []),
        onImportCommitted: vi.fn(async () => undefined),
        notify: vi.fn(),
      });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => controller.selectFiles([await documentPackageFile()]));
    for (let index = 0; index < 50 && (!controller.documentSeriesPlan || controller.seriesBusy); index += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }

    expect(controller.seriesPlan).toBeUndefined();
    expect(controller.seriesError).toBeUndefined();
    expect(controller.documentSeriesInspection).toMatchObject({ workTitle: '압축 작품', format: 'txt' });
    expect(controller.documentSeriesPlan).toMatchObject({ addCount: 2, duplicateCount: 0, conflictCount: 0 });
    await act(async () => renderer.unmount());
  });

  it('prepares a nested package as one work before starting import', async () => {
    let controller!: ImportFeatureController;
    const service: ImportService = { importFile: vi.fn() };
    function Harness() {
      controller = useImportController({
        importService: service,
        getNovel: vi.fn(async () => undefined),
        listNovels: vi.fn(async () => []),
        listChapters: vi.fn(async () => []),
        onImportCommitted: vi.fn(async () => undefined),
        notify: vi.fn(),
      });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => {
      controller.selectFiles([await packageFile()]);
    });
    for (let index = 0; index < 50 && (!controller.seriesPlan || controller.seriesBusy); index += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }

    expect(controller.seriesInspection).toMatchObject({
      sourceKind: 'nested_package',
      workTitle: '서른의 봄',
    });
    expect(controller.seriesPlan).toMatchObject({ addCount: 2, duplicateCount: 0, conflictCount: 0 });
    expect(controller.duplicateConflicts).toEqual([]);
    await act(async () => renderer.unmount());
  });

  it('builds one aggregate archive and sends it through the existing import boundary', async () => {
    vi.stubGlobal('window', globalThis);
    let controller!: ImportFeatureController;
    let importedFile: File | undefined;
    const importedNovel: Novel = {
      id: 'series-book',
      format: 'image_archive',
      title: '서른의 봄',
      sourceFileName: '서른의 봄.cbz',
      rawText: '',
      normalizedText: '',
      rawTextHash: 'series-hash',
      normalizedTextHash: 'series-normalized',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      totalChapters: 2,
      documentSectionCount: 2,
      totalCharacters: 2,
      totalParagraphs: 2,
      coverSeed: 1,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    };
    const importFile = vi.fn<ImportService['importFile']>((input, onProgress) => {
      importedFile = input.file;
      onProgress({
        jobId: 'job-series',
        status: 'ready',
        subphase: 'complete',
        bytesRead: input.file.size,
        totalBytes: input.file.size,
        chaptersDetected: 2,
        paragraphsWritten: 2,
      });
      return { jobId: 'job-series', cancel: vi.fn(), promise: Promise.resolve({ novel: importedNovel }) };
    });
    const onImportCommitted = vi.fn(async () => undefined);
    function Harness() {
      controller = useImportController({
        importService: { importFile },
        getNovel: vi.fn(async () => undefined),
        listNovels: vi.fn(async () => []),
        listChapters: vi.fn(async () => []),
        onImportCommitted,
        notify: vi.fn(),
      });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => {
      controller.selectFiles([await packageFile()]);
    });
    for (let index = 0; index < 50 && (!controller.seriesPlan || controller.seriesBusy); index += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    await act(async () => controller.startPendingImport());

    expect(importFile).toHaveBeenCalledOnce();
    expect(importedFile?.name).toBe('서른의 봄.cbz');
    expect((await readLocalSeriesManifest(importedFile!))?.chapters).toHaveLength(2);
    expect(onImportCommitted).toHaveBeenCalledWith(importedNovel);
    await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });

  it('sends only new local comic chapters through a capable incremental import boundary', async () => {
    vi.stubGlobal('window', globalThis);
    const existing: Novel = {
      id: 'local-comic-series',
      activeContentRevisionId: 'revision-before-append',
      sourceAssetId: 'source-before-append',
      format: 'image_archive',
      title: '서른의 봄',
      sourceFileName: '서른의 봄.cbz',
      rawText: '',
      normalizedText: '',
      rawTextHash: 'aggregate-before',
      normalizedTextHash: 'normalized-before',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      totalChapters: 1,
      documentSectionCount: 1,
      totalCharacters: 1,
      totalParagraphs: 1,
      coverSeed: 1,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    };
    const existingSectionId = stableId('local_series_release', '서른의 봄:c:1', 20);
    const exportSource = vi.fn(async () => undefined);
    let receivedInput: Parameters<ImportService['importFile']>[0] | undefined;
    const importFile = vi.fn<ImportService['importFile']>((input) => {
      receivedInput = input;
      return {
        jobId: 'job-local-comic-delta',
        cancel: vi.fn(),
        promise: Promise.resolve({ novel: { ...existing, documentSectionCount: 2, totalChapters: 2 } }),
      };
    });
    let controller!: ImportFeatureController;
    function Harness() {
      controller = useImportController({
        importService: { importFile, supportsIncrementalImageSeriesAppend: true },
        assets: { exportSource } as unknown as BookAssetRepository,
        getNovel: vi.fn(async () => existing),
        listNovels: vi.fn(async () => [existing]),
        listChapters: vi.fn(async () => [
          {
            id: 'page-1',
            novelId: existing.id,
            index: 1,
            title: '1화',
            normalizedText: '',
            textHash: 'page-1',
            rawStartOffset: 0,
            rawEndOffset: 1,
            characterCount: 1,
            paragraphCount: 1,
            documentSectionId: existingSectionId,
            documentSectionTitle: '1화',
            documentSectionIndex: 1,
            documentPageIndexInSection: 1,
            createdAt: existing.createdAt,
            updatedAt: existing.updatedAt,
          },
        ]),
        onImportCommitted: vi.fn(async () => undefined),
        notify: vi.fn(),
      });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => controller.openChapterAppend(existing));
    await act(async () => controller.selectFiles([await chapter('서른의 봄 2화.cbz')]));
    for (let index = 0; index < 50 && (!controller.seriesPlan || controller.seriesBusy); index += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }

    expect(controller.seriesPlan).toMatchObject({ incrementalAppend: true, addCount: 1, conflictCount: 0 });
    expect(exportSource).not.toHaveBeenCalled();
    await act(async () => controller.startPendingImport());

    expect(receivedInput).toMatchObject({
      clientBookId: existing.id,
      importMode: 'append_image_series',
      baseActiveContentRevisionId: existing.activeContentRevisionId,
    });
    expect(receivedInput?.expectedSourceContentHash).toBe(
      integrityHash(new Uint8Array(await receivedInput!.file.arrayBuffer())),
    );
    expect(await readLocalSeriesManifest(receivedInput!.file)).toMatchObject({
      targetBookId: existing.id,
      chapters: [
        {
          remoteId: stableId('local_series_release', `${existing.id}:c:2`, 20),
          title: '2화',
        },
      ],
    });
    await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });

  it('appends only new TXT chapters to an explicitly selected local Library work', async () => {
    vi.stubGlobal('window', globalThis);
    const existingFile = new File(['제1화\n\n첫 번째 본문입니다.'], '작품 1화.txt', { type: 'text/plain' });
    const incomingFile = new File(['제1화\n\n첫 번째 본문입니다.\n\n제2화\n\n두 번째 본문입니다.'], '작품 2화.txt', {
      type: 'text/plain',
    });
    const preview = await inspectDocumentSeriesSource({
      fileName: existingFile.name,
      blob: existingFile,
      format: 'txt',
      encoding: 'utf-8',
      chapterSplitMode: 'auto',
    });
    const existing: Novel = {
      id: 'local-text-book',
      format: 'txt',
      title: '작품',
      sourceFileName: existingFile.name,
      sourceEncoding: 'utf-8',
      rawText: '',
      normalizedText: '',
      rawTextHash: integrityHash(new Uint8Array(await existingFile.arrayBuffer())),
      normalizedTextHash: preview.chapters[0]!.textHash,
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      totalChapters: 1,
      totalCharacters: preview.chapters[0]!.characterCount,
      totalParagraphs: preview.chapters[0]!.paragraphCount,
      coverSeed: 1,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    };
    const existingChapters = preview.chapters.map((chapter) => ({
      ...chapter,
      id: `existing-${chapter.index}`,
      novelId: existing.id,
      normalizedText: '',
      rawStartOffset: 0,
      rawEndOffset: chapter.characterCount,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    }));
    const sourceHash = integrityHash(new Uint8Array(await existingFile.arrayBuffer()));
    const assets = {
      exportSource: vi.fn(async () => ({
        metadata: {
          id: 'source-asset',
          bookId: existing.id,
          kind: 'source',
          provenance: 'original',
          status: 'active',
          storageKey: 'source-asset',
          fileName: existingFile.name,
          contentType: 'text/plain',
          contentHash: sourceHash,
          byteLength: existingFile.size,
          encoding: 'utf-8',
          createdAt: existing.createdAt,
        },
        blob: existingFile,
      })),
    } as unknown as BookAssetRepository;
    let importedFile: File | undefined;
    const importedNovel = { ...existing, sourceFileName: '작품.moya.zip', totalChapters: 2 };
    const importFile = vi.fn<ImportService['importFile']>((input) => {
      importedFile = input.file;
      return { jobId: 'job-text-series', cancel: vi.fn(), promise: Promise.resolve({ novel: importedNovel }) };
    });
    let controller!: ImportFeatureController;
    function Harness() {
      controller = useImportController({
        importService: { importFile },
        assets,
        getNovel: vi.fn(async () => existing),
        listNovels: vi.fn(async () => [existing]),
        listChapters: vi.fn(async () => existingChapters),
        onImportCommitted: vi.fn(async () => undefined),
        notify: vi.fn(),
      });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => controller.openChapterAppend(existing));
    await act(async () => controller.selectFiles([incomingFile]));
    for (let index = 0; index < 60 && (!controller.documentSeriesPlan || controller.seriesBusy); index += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    expect(controller.documentSeriesPlan).toMatchObject({ addCount: 1, duplicateCount: 1, conflictCount: 0 });
    await act(async () => controller.startPendingImport());

    expect(importFile).toHaveBeenCalledOnce();
    expect(importedFile?.name).toBe('작품.moya.zip');
    const parsed = await materializeDocumentSeriesArchive(importedFile!, {
      fileName: importedFile!.name,
      clientBookId: existing.id,
    });
    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['제1화', '제2화']);
    await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });
});
