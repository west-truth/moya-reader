import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOCUMENT_SERIES_CONTENT_TYPE, readDocumentSeriesArchive } from '@noveldesk/document-series-core';
import { integrityHash } from '@noveldesk/text-core/hash';
import type { Novel } from '../../domain/types';
import type {
  ImportFileInput,
  ImportProgress,
  ImportResult,
  ImportService,
} from '../../services/import/import-service';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { ExternalSourceRegistryPort } from '../app-external-source-registry';
import type { ExternalSourceCollectionDescriptorV2, NormalizedDownloadedExternalSource } from '../contracts';
import { ExternalSourceLocalStateStore, resetExternalSourceLocalStateForTests } from '../local-state';
import { reconcilePendingExternalSourceLinks } from '../link-import-reconciliation';
import { assembleDocumentSeries, type ExternalDocumentSeriesReleaseInput } from './document-series-assembler';
import { externalDocumentCollectionId } from './document-series-identity';
import { importDocumentSeries, type DocumentSeriesImportOptions } from './document-series-import-coordinator';

afterEach(() => resetExternalSourceLocalStateForTests());
const collection: ExternalSourceCollectionDescriptorV2 = {
  remoteId: 'work',
  title: 'Fixture work',
  seriesProfile: { kind: 'document_series', format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' },
};
const item = (id: number): DocumentSeriesImportOptions['items'][number] => ({
  key: { connectorId: 'fixture.text', accountConnectionId: 'fixture-account', remoteId: `release-${id}` },
  kind: 'file',
  title: `Chapter ${id}`,
  collection,
  release: { title: `Chapter ${id}`, sourceOrder: id },
  importability: 'supported',
  remoteRevision: `remote-${id}`,
});

function fixture() {
  const state = new ExternalSourceLocalStateStore();
  const abort = new AbortController();
  const bookId = externalDocumentCollectionId(item(1).key, collection.remoteId);
  let novel: Novel | undefined;
  let source: File | undefined;
  let revision = 0;
  let generation = 'connection-1';
  const bodies = new Map<string, string>();
  const release = (selected: DocumentSeriesImportOptions['items'][number]): ExternalDocumentSeriesReleaseInput => {
    const body = bodies.get(selected.key.remoteId) ?? `Body ${selected.key.remoteId}.`;
    return {
      item: selected,
      content: {
        kind: 'document',
        file: new File([body], `${selected.key.remoteId}.txt`, { type: 'text/plain' }),
        format: 'txt',
        encoding: 'utf-8',
        chapterSplitMode: 'single',
      },
      sourceContentHash: integrityHash(body),
      remoteRevision: selected.remoteRevision,
    };
  };
  const commitFile = async (file: File): Promise<ImportResult> => {
    const archive = (await readDocumentSeriesArchive(file))!;
    source = file;
    novel = {
      id: bookId,
      title: collection.title,
      format: 'txt',
      sourceFileName: file.name,
      sourceEncoding: 'utf-8',
      rawText: '',
      normalizedText: '',
      rawTextHash: '',
      normalizedTextHash: '',
      createdAt: '',
      updatedAt: '',
      totalChapters: archive.manifest.sources.length,
      totalParagraphs: archive.manifest.sources.length,
      totalCharacters: 0,
      coverSeed: 0,
      favorite: false,
      lastReadOffset: 0,
      lastReadProgress: 0,
      analysisStatus: 'not_analyzed',
      activeContentRevisionId: `revision-${++revision}`,
      sourceContentHash: integrityHash(new Uint8Array(await file.arrayBuffer())),
    };
    return { novel };
  };
  const hooks: {
    beforeImport?: (input: ImportFileInput) => Promise<void>;
    afterImport?: () => Promise<void>;
    download?: () => void;
  } = {};
  const importFile = vi.fn<ImportService['importFile']>((input) => ({
    jobId: 'fixture-job',
    cancel: vi.fn(),
    promise: (async () => {
      await hooks.beforeImport?.(input);
      if (
        input.expectedBase?.kind === 'absent'
          ? Boolean(novel)
          : novel?.activeContentRevisionId !==
            (input.expectedBase?.kind === 'revision' ? input.expectedBase.contentRevisionId : undefined)
      )
        throw new Error('import_expected_base_conflict');
      const result = await commitFile(input.file);
      await hooks.afterImport?.();
      return result;
    })(),
  }));
  const importService: ImportService = {
    supportsExpectedBase: true,
    supportsExpectedSourceContentHash: true,
    importFile,
  };
  const download = vi.fn<ExternalSourceRegistryPort['downloadExternalSource']>(async (_id, _context, ref) => {
    hooks.download?.();
    expect(ref.context?.expectedProfile).toEqual(collection.seriesProfile);
    const selected = selectedItems.find((candidate) => candidate.key.remoteId === ref.key.remoteId)!;
    const value = release(selected);
    return {
      file: value.content.file,
      content: value.content,
      remoteRevision: value.remoteRevision,
    } satisfies NormalizedDownloadedExternalSource;
  });
  let selectedItems: DocumentSeriesImportOptions['items'] = [];
  const registry = {
    downloadExternalSource: download,
    getExternalSourceStatus: () => ({
      state: 'connected',
      accountConnectionId: 'fixture-account',
      connectionGeneration: generation,
    }),
  } as unknown as ExternalSourceRegistryPort;
  const getNovel = vi.fn(async () => novel);
  const assets = {
    exportSource: vi.fn(async () =>
      source && novel
        ? {
            blob: source,
            metadata: {
              id: 'source',
              bookId,
              kind: 'source',
              provenance: 'original',
              status: 'active',
              storageKey: 'fixture',
              createdAt: '',
              contentType: DOCUMENT_SERIES_CONTENT_TYPE,
              byteLength: source.size,
              contentHash: novel.sourceContentHash!,
            },
          }
        : undefined,
    ),
  } as unknown as BookAssetRepository;
  const onProgress = vi.fn<DocumentSeriesImportOptions['onProgress']>();
  const onCommitted = vi.fn<DocumentSeriesImportOptions['onCommitted']>(async () => undefined);
  const onReplacedRelease = vi.fn();
  const options = (): DocumentSeriesImportOptions => ({
    sourceId: 'fixture.text',
    items: selectedItems,
    registry,
    hostContext: { brokers: { get: () => undefined } } as never,
    state,
    assets,
    importService,
    signal: abort.signal,
    getNovel,
    onProgress,
    onCommitted,
    onReplacedRelease,
  });
  return {
    state,
    abort,
    bookId,
    bodies,
    importFile,
    importService,
    download,
    hooks,
    getNovel,
    assets,
    onProgress,
    onCommitted,
    onReplacedRelease,
    novel: () => novel,
    source: () => source,
    setGeneration: () => {
      generation = 'connection-2';
    },
    async run(items: DocumentSeriesImportOptions['items']) {
      selectedItems = items;
      await importDocumentSeries(options());
    },
    async seed(items: DocumentSeriesImportOptions['items']) {
      const assembled = await assembleDocumentSeries({
        collection,
        releases: items.map(release),
        targetBookId: bookId,
        existingSource: source ? { blob: source, contentType: DOCUMENT_SERIES_CONTENT_TYPE } : undefined,
        expectedBase: novel
          ? { kind: 'revision', contentRevisionId: novel.activeContentRevisionId! }
          : { kind: 'absent' },
        signal: new AbortController().signal,
      });
      if (assembled.file) await commitFile(assembled.file);
    },
  };
}

describe('TXT series import coordinator', () => {
  it('identifies each downloading release and only the active batch in import and commit progress', async () => {
    const h = fixture();
    const selected = Array.from({ length: 51 }, (_, index) => item(index + 1));
    h.hooks.download = () => {
      const progress = h.onProgress.mock.lastCall![0];
      expect(progress.item).toBe(selected[h.download.mock.calls.length - 1]);
      expect(progress.stage).toBe('downloading');
      expect(progress.items).toBeUndefined();
    };
    const importFile = h.importFile.getMockImplementation()!;
    const detail: ImportProgress = {
      jobId: 'fixture-job',
      status: 'writing',
      subphase: 'writing_pages',
      bytesRead: 1,
      totalBytes: 1,
      chaptersDetected: 1,
      paragraphsWritten: 1,
    };
    h.importFile.mockImplementation((input, onProgress) => {
      onProgress?.(detail);
      return importFile(input, onProgress);
    });
    await h.run(selected);
    const progress = h.onProgress.mock.calls.map(([value]) => value);
    expect(
      progress.filter((value) => value.stage === 'verifying').map((value) => [value.item, value.received]),
    ).toEqual(selected.map((value, index) => [value, index + 1]));
    const importing = progress.filter((value) => value.detail);
    expect(importing.map((value) => value.items)).toEqual([selected.slice(0, 50), selected.slice(50)]);
    expect(importing.every((value) => value.item === undefined && value.detail === detail)).toBe(true);
    const committed = progress.filter((value) => value.items && !value.detail);
    expect(committed.map((value) => [value.committed, value.items])).toEqual([
      [50, selected.slice(0, 50)],
      [51, selected.slice(50)],
    ]);
  });

  it('reports reader-state review only for committed byte replacements', async () => {
    const h = fixture();
    await h.run([item(1)]);
    await h.run([item(2)]);
    await h.run([item(1)]);
    expect(h.onReplacedRelease).not.toHaveBeenCalled();
    h.bodies.set('release-1', 'newly revised body');
    await h.run([item(1)]);
    expect(h.onReplacedRelease).toHaveBeenCalledOnce();
  });

  it('checks exported bytes against the captured revision before downloading a replacement', async () => {
    const h = fixture();
    await h.seed([item(1)]);
    const exported = (await h.assets.exportSource(h.bookId))!;
    vi.spyOn(h.assets, 'exportSource').mockResolvedValue({ ...exported, blob: new Blob(['wrong bytes']) });
    await expect(h.run([item(2)])).rejects.toThrow('원본');
    expect(h.download).not.toHaveBeenCalled();
    expect(h.importFile).not.toHaveBeenCalled();
  });

  it('preserves pending recovery when a rejected import cannot have its outcome read', async () => {
    const h = fixture();
    h.hooks.afterImport = async () => {
      h.getNovel.mockRejectedValue(new Error('offline'));
      throw new Error('response lost');
    };
    await expect(h.run([item(1)])).rejects.toThrow('response lost');
    expect((await h.state.listLinks())[0]!.pendingImport).toBeDefined();
    h.getNovel.mockResolvedValue(h.novel());
    await reconcilePendingExternalSourceLinks(h.state, await h.state.listLinks(), [h.novel()!]);
    expect((await h.state.listLinks())[0]!.pendingImport).toBeUndefined();
  });

  it('stops after one fresh reassembly if activation keeps conflicting', async () => {
    const h = fixture();
    await h.run([item(1)]);
    let competing = 90;
    h.hooks.beforeImport = async () => {
      await h.seed([item(++competing)]);
    };
    await expect(h.run([item(2)])).rejects.toThrow('import_expected_base_conflict');
    expect(h.importFile).toHaveBeenCalledTimes(3);
    expect(h.download).toHaveBeenCalledTimes(2);
    expect((await h.state.listLinks()).every((link) => !link.pendingImport)).toBe(true);
  });
  it('creates one book, uses its revision snapshot on append, and repairs missing links without reimport', async () => {
    const h = fixture();
    await h.run([item(1), item(2)]);
    expect(h.importFile.mock.calls[0]![0]).toMatchObject({ clientBookId: h.bookId, expectedBase: { kind: 'absent' } });
    const revision = h.novel()!.activeContentRevisionId;
    await h.run([item(3)]);
    expect(h.importFile.mock.calls[1]![0].expectedBase).toEqual({ kind: 'revision', contentRevisionId: revision });
    expect(h.novel()!.totalChapters).toBe(3);
    const links = await h.state.listLinks();
    await h.state.deleteLinks([links.find((link) => link.source.remoteId === 'release-2')!.id]);
    const acquire = vi.spyOn(h.state, 'acquirePendingLinks');
    const finalize = vi.spyOn(h.state, 'compareAndSwapPendingLinks');
    await h.run([{ ...item(2), remoteRevision: 'checked-again' }]);
    expect(h.importFile).toHaveBeenCalledTimes(2);
    expect(acquire).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
    expect((await h.state.listLinks()).find((link) => link.source.remoteId === 'release-2')).toMatchObject({
      importedRemoteRevision: 'checked-again',
      pendingImport: undefined,
      activeContentRevisionId: h.novel()!.activeContentRevisionId,
    });
  });

  it('cuts batches at 50 releases and carries a downloaded overflow across the 4 MiB boundary', async () => {
    const h = fixture();
    await h.run(Array.from({ length: 51 }, (_, index) => item(index + 1)));
    expect(h.importFile).toHaveBeenCalledTimes(2);
    expect(h.onCommitted.mock.calls.map((call) => call[1].length)).toEqual([50, 1]);
    h.onCommitted.mockClear();
    for (const id of [52, 53, 54]) h.bodies.set(`release-${id}`, 'x'.repeat(1536 * 1024));
    await h.run([item(52), item(53), item(54)]);
    expect(h.onCommitted.mock.calls.map((call) => call[1].length)).toEqual([2, 1]);
    expect(h.download).toHaveBeenCalledTimes(54);
    expect(
      h.onProgress.mock.calls
        .map(([value]) => value)
        .filter((value) => value.item?.key.remoteId === 'release-54')
        .map((value) => value.stage),
    ).toEqual(['downloading', 'verifying', 'verifying']);
  }, 20_000);

  it('retains committed batches and stops starting work after cancellation', async () => {
    const h = fixture();
    h.onCommitted.mockImplementationOnce(async () => {
      h.abort.abort();
    });
    await expect(h.run(Array.from({ length: 51 }, (_, index) => item(index + 1)))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(h.download).toHaveBeenCalledTimes(50);
    expect(h.novel()!.totalChapters).toBe(50);
    expect(await h.state.listLinks()).toHaveLength(50);
  });

  it('does not acquire pending links when a download fails and restores unapplied import intents', async () => {
    const h = fixture();
    h.hooks.download = () => {
      throw new Error('download failed');
    };
    await expect(h.run([item(1)])).rejects.toThrow('download failed');
    expect(await h.state.listLinks()).toEqual([]);
    h.hooks.download = undefined;
    h.hooks.beforeImport = async () => {
      throw new Error('parse failed');
    };
    await expect(h.run([item(1)])).rejects.toThrow('parse failed');
    expect(await h.state.listLinks()).toEqual([]);
    expect(h.novel()).toBeUndefined();
  });

  it('reconciles a commit even when late cancellation rejects its response', async () => {
    const h = fixture();
    h.hooks.afterImport = async () => {
      h.abort.abort();
      throw new DOMException('late cancellation', 'AbortError');
    };
    await h.run([item(1)]);
    expect((await h.state.listLinks())[0]).toMatchObject({
      pendingImport: undefined,
      activeContentRevisionId: h.novel()!.activeContentRevisionId,
    });
    expect(h.onProgress.mock.calls.at(-1)![0]).toMatchObject({ committed: 1, items: [item(1)] });
    expect(h.onCommitted).toHaveBeenCalledOnce();
  });

  it('leaves a committed intent recoverable when finalizing links fails', async () => {
    const h = fixture();
    const finalize = vi.spyOn(h.state, 'compareAndSwapPendingLinks').mockResolvedValue(false);
    await expect(h.run([item(1)])).rejects.toThrow('본문은 저장되었습니다');
    expect(h.onProgress.mock.calls.at(-1)![0]).toMatchObject({ committed: 1, items: [item(1)] });
    expect((await h.state.listLinks())[0]!.pendingImport).toBeDefined();
    finalize.mockRestore();
    await reconcilePendingExternalSourceLinks(h.state, await h.state.listLinks(), [h.novel()!]);
    expect((await h.state.listLinks())[0]!.pendingImport).toBeUndefined();
  });

  it('reassembles once against a newer snapshot while preserving a concurrently appended release', async () => {
    const h = fixture();
    await h.run([item(1)]);
    h.hooks.beforeImport = async () => {
      h.hooks.beforeImport = undefined;
      await h.seed([item(3)]);
    };
    await h.run([item(2)]);
    expect(h.importFile).toHaveBeenCalledTimes(3);
    expect(h.novel()!.totalChapters).toBe(3);
    expect(h.download).toHaveBeenCalledTimes(2);
    expect(h.importFile.mock.calls[1]![0].file).not.toBe(h.importFile.mock.calls[2]![0].file);
  });

  it('does not overwrite the same release changed by a concurrent operation during retry', async () => {
    const h = fixture();
    await h.run([item(1)]);
    h.bodies.set('release-1', 'selected replacement');
    h.hooks.beforeImport = async () => {
      h.hooks.beforeImport = undefined;
      h.bodies.set('release-1', 'concurrent replacement');
      await h.seed([item(1)]);
    };
    await expect(h.run([item(1)])).rejects.toThrow('기존 본문');
    expect(h.importFile).toHaveBeenCalledTimes(2);
    const archive = (await readDocumentSeriesArchive(h.source()!))!;
    expect(await [...archive.sources.values()][0]!.text()).toBe('concurrent replacement');
  });

  it('requires safe import support and refuses a connection changed after download', async () => {
    const h = fixture();
    h.hooks.download = h.setGeneration;
    await expect(h.run([item(1)])).rejects.toThrow('연결이 변경');
    expect(h.importFile).not.toHaveBeenCalled();
    expect(await h.state.listLinks()).toEqual([]);
    Object.assign(h.importService, { supportsExpectedBase: false });
    await expect(h.run([item(1)])).rejects.toThrow('안전한 텍스트');
  });
});
