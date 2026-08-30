import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import { integrityHash } from '@noveldesk/text-core/hash';
import { sha256 } from '../../domain/hash';
import type { BookAssetMetadata, Chapter, Novel } from '../../domain/types';
import type { ExternalSourceBrowseState, ExternalSourceLink } from '../../external-sources/contracts';
import type {
  ExternalSourceCatalogPreference,
  ExternalSourceDefaultFolder,
  ExternalSourceLocalState,
  ExternalSourceSubscriptionRecord,
} from '../../external-sources/local-state';
import type { ImportService } from '../../services/import/import-service';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { buildSeriesImageArchive, readSeriesImageArchiveManifest } from '../../services/import/series-image-archive';
import { testChapter } from '../book-workspace/book-workspace-test-fixtures';
import {
  useExternalSourceController,
  type ExternalSourceController,
  type ExternalSourceRegistryPort,
} from './useExternalSourceController';

const SOURCE_ID = 'fixture.source' as ExtensionContributionId;
const ITEM_KEY = {
  connectorId: SOURCE_ID,
  accountConnectionId: 'fixture-account',
  remoteId: 'work-1',
} as const;

function novel(overrides: Partial<Novel> = {}): Novel {
  return {
    id: 'book-1',
    title: '연결된 작품',
    sourceFileName: 'work.txt',
    sourceEncoding: 'utf-8',
    rawText: '기존 본문',
    normalizedText: '기존 본문',
    rawTextHash: 'old-raw-hash',
    normalizedTextHash: 'old-normalized-hash',
    sourceContentHash: 'old-source-hash',
    activeContentRevisionId: 'content-old',
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    totalChapters: 1,
    totalCharacters: 5,
    totalParagraphs: 1,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
    ...overrides,
  };
}

async function createHarness(input: {
  downloadedContent: string;
  importedContent?: Novel;
  importError?: Error;
  getNovelErrorAfterImport?: boolean;
  localBookMissing?: boolean;
  defaultFolder?: ExternalSourceDefaultFolder;
  failFolderRef?: string;
  pickable?: boolean;
  thumbnailUrl?: string;
  chapters?: Chapter[];
  supportsSubscriptions?: boolean;
  subscriptions?: ExternalSourceSubscriptionRecord[];
  catalogPreference?: ExternalSourceCatalogPreference;
  browse?: ExternalSourceBrowseState;
  serial?: boolean;
  downloadedFile?: File;
  downloadGate?: Promise<void>;
  assets?: BookAssetRepository;
  supportsExactDocumentSectionReadMarkers?: boolean;
  supportsIncrementalImageSeriesAppend?: boolean;
  supportsExpectedSourceContentHash?: boolean;
  novelOverrides?: Partial<Novel>;
  initialLinkOverrides?: Partial<ExternalSourceLink>;
}) {
  const oldContent = '기존 원격 원문';
  const oldHash = await sha256(oldContent);
  const downloadedHash = await sha256(input.downloadedContent);
  const currentNovel = novel({ sourceContentHash: oldHash, ...input.novelOverrides });
  let currentLink: ExternalSourceLink = {
    id: 'external-link::fixture.source::fixture-account::work-1',
    source: ITEM_KEY,
    localBookId: currentNovel.id,
    importedRemoteRevision: 'remote-r1',
    importedSourceContentHash: oldHash,
    activeContentRevisionId: currentNovel.activeContentRevisionId,
    linkedAt: '2026-08-23T00:00:00.000Z',
    ...input.initialLinkOverrides,
  };
  const saveLink = vi.fn(async (link: ExternalSourceLink) => {
    currentLink = link;
  });
  let subscriptions = [...(input.subscriptions ?? [])];
  let catalogPreference = input.catalogPreference;
  const state: ExternalSourceLocalState = {
    getOrCreateCredentialKey: vi.fn(),
    getCredential: vi.fn(async () => undefined),
    saveCredential: vi.fn(async () => undefined),
    deleteCredential: vi.fn(async () => undefined),
    getCachePage: vi.fn(async () => undefined),
    saveCachePage: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    listLinks: vi.fn(async () => [currentLink]),
    saveLink,
    getDefaultFolder: vi.fn(async () => input.defaultFolder),
    saveDefaultFolder: vi.fn(async () => undefined),
    deleteDefaultFolder: vi.fn(async () => undefined),
    getCatalogPreference: vi.fn(async () => catalogPreference),
    saveCatalogPreference: vi.fn(async (preference) => {
      catalogPreference = preference;
    }),
    listSubscriptions: vi.fn(async (connectorId, accountConnectionId) =>
      subscriptions.filter(
        (record) =>
          (!connectorId || record.connectorId === connectorId) &&
          (accountConnectionId === undefined || record.accountConnectionId === accountConnectionId),
      ),
    ),
    saveSubscription: vi.fn(async (record) => {
      subscriptions = [...subscriptions.filter((item) => item.id !== record.id), record];
    }),
    deleteSubscription: vi.fn(async (id) => {
      subscriptions = subscriptions.filter((item) => item.id !== id);
    }),
    listSelectedItems: vi.fn(async () => []),
    saveSelectedItem: vi.fn(async () => undefined),
    deleteSelectedItem: vi.fn(async () => undefined),
  };
  let latestImportedNovel: Novel | undefined;
  const importFile = vi.fn<ImportService['importFile']>((request) => {
    return {
      jobId: 'import-job',
      cancel: vi.fn(),
      promise: (async () => {
        if (input.importError) throw input.importError;
        latestImportedNovel =
          input.importedContent ??
          novel({
            id: request.clientBookId ?? 'book-new',
            sourceContentHash: input.serial ? await sha256(await request.file.arrayBuffer()) : downloadedHash,
            activeContentRevisionId: 'content-new',
          });
        return { novel: latestImportedNovel };
      })(),
    };
  });
  const registry: ExternalSourceRegistryPort = {
    getExternalSources: () => [
      {
        descriptor: {
          id: SOURCE_ID,
          schemaVersion: 1,
          title: '개발용 소스',
          kind: 'catalog',
          capabilities: ['browse', 'work-import', ...(input.supportsSubscriptions ? (['subscriptions'] as const) : [])],
          runtimes: ['web-direct'],
        },
      },
    ],
    getExternalSourceStatus: () => ({
      state: 'connected',
      accountConnectionId: 'fixture-account',
    }),
    connectExternalSource: vi.fn(async () => undefined),
    disconnectExternalSource: vi.fn(async () => undefined),
    listExternalSource: vi.fn(async (_sourceId, _hostContext, listInput) => {
      if (input.failFolderRef !== undefined && listInput.parentRef === input.failFolderRef) {
        throw new Error('folder not found');
      }
      return {
        items: input.serial
          ? [
              {
                key: ITEM_KEY,
                kind: 'file' as const,
                title: '1화',
                mimeType: 'application/vnd.comicbook+zip',
                remoteRevision: 'remote-r2',
                collection: { remoteId: 'manga:1', title: '연동 작품' },
                release: { title: '1화', chapterNumber: 1 },
                importability: 'supported' as const,
              },
            ]
          : [
              {
                key: ITEM_KEY,
                kind: 'work' as const,
                title: 'work.txt',
                mimeType: 'text/plain',
                thumbnailUrl: input.thumbnailUrl,
                remoteRevision: 'remote-r2',
                importability: 'supported' as const,
              },
            ],
        browse: input.browse
          ? {
              ...input.browse,
              activeMode: listInput.browseMode ?? input.browse.activeMode,
            }
          : undefined,
      };
    }),
    downloadExternalSource: vi.fn(async () => {
      await input.downloadGate;
      return {
        file: input.downloadedFile ?? new File([input.downloadedContent], 'work.txt', { type: 'text/plain' }),
        remoteRevision: 'remote-r2',
      };
    }),
    canPickExternalSource: vi.fn(() => Boolean(input.pickable)),
    pickExternalSource: vi.fn(async () => ({ selectedCount: 1, addedCount: 1 })),
    canRemoveExternalSourceItem: vi.fn(() => Boolean(input.pickable)),
    removeExternalSourceItem: vi.fn(async () => undefined),
  };
  const confirm = vi.fn(() => true);
  const notify = vi.fn();
  const openNovel = vi.fn();
  const onLibraryChanged = vi.fn(async () => undefined);
  let controller!: ExternalSourceController;
  function Harness() {
    controller = useExternalSourceController({
      registry,
      hostContext: { brokers: { get: () => undefined } },
      state,
      importService: {
        importFile,
        supportsIncrementalImageSeriesAppend: input.supportsIncrementalImageSeriesAppend,
        supportsExpectedSourceContentHash: input.supportsExpectedSourceContentHash,
      },
      assets: input.assets,
      supportsExactDocumentSectionReadMarkers: input.supportsExactDocumentSectionReadMarkers,
      extensionRevision: 0,
      listNovels: async () => (input.localBookMissing ? [] : [currentNovel]),
      listChapters: async () => input.chapters ?? [],
      getNovel: async (id) => {
        if (input.getNovelErrorAfterImport && latestImportedNovel?.id === id) {
          throw new Error('fixture post-import read failed');
        }
        return latestImportedNovel?.id === id ? latestImportedNovel : id === currentNovel.id ? currentNovel : undefined;
      },
      openNovel,
      onLibraryChanged,
      notify,
      confirm,
    });
    return null;
  }

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => {
    await controller.selectSource(SOURCE_ID);
  });
  await act(async () => {
    controller.toggleItem('fixture.source::fixture-account::work-1');
  });

  return {
    get controller() {
      return controller;
    },
    importFile,
    saveLink,
    confirm,
    notify,
    openNovel,
    onLibraryChanged,
    registry,
    state,
    get currentLink() {
      return currentLink;
    },
    get subscriptions() {
      return subscriptions;
    },
    get catalogPreference() {
      return catalogPreference;
    },
    renderer,
    oldHash,
  };
}

async function singlePageComicFile(): Promise<File> {
  const page = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
  await writer.add('001.png', new Uint8ArrayReader(page));
  return new File([await writer.close()], '1화.cbz', { type: 'application/vnd.comicbook+zip' });
}

describe('useExternalSourceController remote updates', () => {
  it('applies extension filters through SEARCH even when the search query is empty', async () => {
    const harness = await createHarness({
      downloadedContent: '기존 원격 원문',
      browse: {
        activeMode: 'popular',
        availableModes: ['popular', 'latest', 'search'],
        filters: [
          { id: '0', position: 0, kind: 'select', label: '장르', options: ['전체', '판타지'], defaultValue: 0 },
        ],
      },
    });
    act(() => harness.controller.setFilterValue('0', 1));
    await act(async () => harness.controller.applyFilters());

    expect(harness.registry.listExternalSource).toHaveBeenLastCalledWith(
      SOURCE_ID,
      expect.anything(),
      expect.objectContaining({
        query: undefined,
        browseMode: 'search',
        filters: [{ position: 0, groupPosition: undefined, value: 1 }],
      }),
      expect.any(AbortSignal),
    );
    expect(harness.controller.browse?.activeMode).toBe('search');
    await act(async () => harness.renderer.unmount());
  });

  it('does not persist session-only blob thumbnail URLs in the source cache', async () => {
    const harness = await createHarness({ downloadedContent: '기존 원격 원문', thumbnailUrl: 'blob:work-cover' });

    expect(harness.state.saveCachePage).toHaveBeenCalledWith(
      expect.objectContaining({ items: [expect.objectContaining({ thumbnailUrl: undefined })] }),
    );
    expect(harness.controller.items[0]?.thumbnailUrl).toBe('blob:work-cover');
    await act(async () => harness.renderer.unmount());
  });

  it('opens a source at its persisted account-specific default folder', async () => {
    const harness = await createHarness({
      downloadedContent: '기존 원격 원문',
      defaultFolder: {
        id: 'external-source-default-folder::fixture.source::fixture-account',
        connectorId: SOURCE_ID,
        accountConnectionId: 'fixture-account',
        parentRef: '/소설/완결',
        breadcrumbs: [
          { label: '소설', parentRef: '/소설' },
          { label: '완결', parentRef: '/소설/완결' },
        ],
        updatedAt: '2026-08-24T00:00:00.000Z',
        schemaVersion: 1,
      },
    });

    expect(harness.registry.listExternalSource).toHaveBeenCalledWith(
      SOURCE_ID,
      expect.anything(),
      expect.objectContaining({ parentRef: '/소설/완결', accountConnectionId: 'fixture-account' }),
      expect.any(AbortSignal),
    );
    expect(harness.controller.breadcrumbs.at(-1)).toEqual({ label: '완결', parentRef: '/소설/완결' });
    expect(harness.controller.currentFolderIsDefault).toBe(true);
    await act(async () => harness.renderer.unmount());
  });

  it('clears an unavailable default folder and falls back to the source root', async () => {
    const unavailableFolder: ExternalSourceDefaultFolder = {
      id: 'external-source-default-folder::fixture.source::fixture-account',
      connectorId: SOURCE_ID,
      accountConnectionId: 'fixture-account',
      parentRef: '/삭제된-폴더',
      breadcrumbs: [{ label: '삭제된 폴더', parentRef: '/삭제된-폴더' }],
      updatedAt: '2026-08-24T00:00:00.000Z',
      schemaVersion: 1,
    };
    const harness = await createHarness({
      downloadedContent: '기존 원격 원문',
      defaultFolder: unavailableFolder,
      failFolderRef: unavailableFolder.parentRef,
    });

    expect(harness.state.deleteDefaultFolder).toHaveBeenCalledWith(SOURCE_ID, 'fixture-account');
    expect(harness.registry.listExternalSource).toHaveBeenLastCalledWith(
      SOURCE_ID,
      expect.anything(),
      expect.objectContaining({ parentRef: undefined, accountConnectionId: 'fixture-account' }),
      expect.any(AbortSignal),
    );
    expect(harness.controller.breadcrumbs).toEqual([{ label: '최상위 폴더' }]);
    expect(harness.notify).toHaveBeenCalledWith('기본 폴더를 열 수 없어 최상위 폴더부터 표시합니다.', 'warning');
    await act(async () => harness.renderer.unmount());
  });

  it('refreshes the same source after picker selection and removes only the remote selection', async () => {
    const harness = await createHarness({ downloadedContent: '기존 원격 원문', pickable: true });

    expect(harness.controller.canPickItems).toBe(true);
    await act(async () => {
      await harness.controller.pickItems();
    });
    expect(harness.registry.pickExternalSource).toHaveBeenCalledWith(SOURCE_ID, expect.anything());
    expect(harness.notify).toHaveBeenCalledWith('1개 Google Drive 파일을 소스에 추가했습니다.', 'success');

    await act(async () => {
      await harness.controller.removeItem(harness.controller.items[0]!);
    });
    expect(harness.registry.removeExternalSourceItem).toHaveBeenCalledWith(SOURCE_ID, expect.anything(), ITEM_KEY);
    expect(harness.confirm).toHaveBeenCalledWith(expect.stringContaining('이미 라이브러리에 가져온 작품은 유지됩니다'));
    await act(async () => harness.renderer.unmount());
  });

  it('uses the same guarded import path for a single card action', async () => {
    const nextNovel = novel({
      id: 'book-1',
      sourceContentHash: await sha256('카드에서 변경한 원문'),
      activeContentRevisionId: 'content-card',
    });
    const harness = await createHarness({ downloadedContent: '카드에서 변경한 원문', importedContent: nextNovel });

    await act(async () => {
      await harness.controller.importItem(harness.controller.items[0]!);
    });

    expect(harness.confirm).toHaveBeenCalledOnce();
    expect(harness.importFile).toHaveBeenCalledWith(
      expect.objectContaining({ clientBookId: 'book-1' }),
      expect.any(Function),
    );
    expect(harness.currentLink.activeContentRevisionId).toBe('content-card');
    await act(async () => harness.renderer.unmount());
  });

  it('keeps an active download running when the source screen is closed', async () => {
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const harness = await createHarness({ downloadedContent: '백그라운드 원문', downloadGate });
    act(() => harness.controller.show(SOURCE_ID));
    expect(harness.controller.open).toBe(true);

    let importPromise!: Promise<void>;
    await act(async () => {
      importPromise = harness.controller.importItem(harness.controller.items[0]!);
      await Promise.resolve();
    });
    expect(harness.controller.busy).toBe(true);

    act(() => harness.controller.close());
    expect(harness.controller.open).toBe(false);
    expect(harness.notify).toHaveBeenCalledWith('다운로드는 백그라운드에서 계속됩니다.');
    act(() => harness.controller.show(SOURCE_ID));
    expect(harness.controller.open).toBe(true);
    act(() => harness.controller.close());

    releaseDownload();
    await act(async () => {
      await importPromise;
    });
    expect(harness.importFile).toHaveBeenCalledOnce();
    expect(harness.controller.busy).toBe(false);
    await act(async () => harness.renderer.unmount());
  });

  it('does not interrupt the current screen after a background chapter download finishes', async () => {
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const harness = await createHarness({
      downloadedContent: '',
      downloadedFile: await singlePageComicFile(),
      downloadGate,
      localBookMissing: true,
      serial: true,
    });
    act(() => harness.controller.show(SOURCE_ID));

    let importPromise!: Promise<void>;
    await act(async () => {
      importPromise = harness.controller.importAndOpen(harness.controller.items[0]!);
      await Promise.resolve();
    });
    expect(harness.controller.busy).toBe(true);
    act(() => harness.controller.close());

    releaseDownload();
    await act(async () => {
      await importPromise;
    });
    expect(harness.importFile).toHaveBeenCalledOnce();
    expect(harness.openNovel).not.toHaveBeenCalled();
    await act(async () => harness.renderer.unmount());
  });

  it('opens an imported source item through the injected book workspace boundary', async () => {
    const harness = await createHarness({ downloadedContent: '기존 원격 원문' });

    await act(async () => {
      await harness.controller.openImported({
        ...harness.controller.items[0]!,
        importState: 'imported',
        localBookId: 'book-1',
        localBookTitle: '연결된 작품',
      });
    });

    expect(harness.openNovel).toHaveBeenCalledWith(expect.objectContaining({ id: 'book-1' }));
    await act(async () => harness.renderer.unmount());
  });

  it('opens a local serialized comic as a release list even without a remote collection link', async () => {
    const chapters = [
      testChapter(1, { documentSectionId: 'local:01', documentSectionTitle: '01화', documentSectionIndex: 1 }),
      testChapter(2, { documentSectionId: 'local:02', documentSectionTitle: '02화', documentSectionIndex: 2 }),
    ];
    const harness = await createHarness({ downloadedContent: '기존 원격 원문', chapters });
    const serialized = novel({ format: 'image_archive', documentSectionCount: 2, totalChapters: 2 });

    await act(async () => {
      await harness.controller.showLocalSeries(serialized);
    });

    expect(harness.controller.open).toBe(true);
    expect(harness.controller.localSeriesNovel?.id).toBe(serialized.id);
    expect(harness.controller.items).toMatchObject([
      { title: '01화', importState: 'imported', localBookId: serialized.id },
      { title: '02화', importState: 'imported', localBookId: serialized.id },
    ]);
    await act(async () => harness.renderer.unmount());
  });

  it.each([
    {
      label: 'local IndexedDB without exact markers',
      supportsExactDocumentSectionReadMarkers: false,
      expected: ['read', 'current', 'unread'],
    },
    {
      label: 'self-host with exact markers',
      supportsExactDocumentSectionReadMarkers: true,
      expected: ['unread', 'current', 'unread'],
    },
  ])('uses the reader capability for serialized read-state fallback: $label', async (input) => {
    const chapters = [1, 2, 3].map((index) =>
      testChapter(index, {
        documentSectionId: `local:${index}`,
        documentSectionTitle: `${index}화`,
        documentSectionIndex: index,
      }),
    );
    const novelOverrides: Partial<Novel> = {
      format: 'image_archive',
      documentSectionCount: 3,
      totalChapters: 3,
      lastReadChapterId: 'chapter-2',
      lastReadChapterIndex: 2,
      lastReadProgress: 0.5,
    };
    const harness = await createHarness({
      downloadedContent: '기존 원격 원문',
      chapters,
      supportsExactDocumentSectionReadMarkers: input.supportsExactDocumentSectionReadMarkers,
      novelOverrides,
    });

    await act(async () => {
      await harness.controller.showLocalSeries(novel(novelOverrides));
    });

    expect(harness.controller.items.map((item) => item.readingState)).toEqual(input.expected);
    await act(async () => harness.renderer.unmount());
  });

  it('opens a catalog work as a detail and chapter page without enabling folder pinning', async () => {
    const harness = await createHarness({ downloadedContent: '기존 원격 원문' });
    vi.mocked(harness.registry.listExternalSource).mockResolvedValueOnce({
      detail: { title: '연동 작품', author: '작가', description: '작품 상세' },
      items: [
        {
          key: { ...ITEM_KEY, remoteId: 'chapter:11' },
          kind: 'file',
          title: '1화',
          mimeType: 'application/vnd.comicbook+zip',
          formatHint: 'CBZ',
          importability: 'supported',
        },
      ],
    });

    await act(async () => {
      await harness.controller.openItem({
        ...harness.controller.items[0]!,
        kind: 'work',
        title: '연동 작품',
        navigationRef: 'manga:1',
        importability: 'unsupported',
        importState: 'unsupported',
      });
    });

    expect(harness.registry.listExternalSource).toHaveBeenLastCalledWith(
      SOURCE_ID,
      expect.anything(),
      expect.objectContaining({ parentRef: 'manga:1' }),
      expect.any(AbortSignal),
    );
    expect(harness.controller.detail).toEqual(expect.objectContaining({ title: '연동 작품', author: '작가' }));
    expect(harness.controller.items[0]).toEqual(expect.objectContaining({ title: '1화', importState: 'available' }));
    expect(harness.controller.currentLocationCanBeDefault).toBe(false);
    await act(async () => harness.renderer.unmount());
  });

  it('persists a catalog browse preference and restores it when reopening the source folder', async () => {
    const preference: ExternalSourceCatalogPreference = {
      id: 'external-source-catalog-preference::fixture.source::fixture-account::source:9',
      connectorId: SOURCE_ID,
      accountConnectionId: 'fixture-account',
      parentRef: 'source:9',
      browseMode: 'latest',
      filterValues: { '0': 1 },
      filters: [{ position: 0, value: 1 }],
      updatedAt: '2026-08-26T00:00:00.000Z',
      schemaVersion: 1,
    };
    const harness = await createHarness({ downloadedContent: '기존 원격 원문', catalogPreference: preference });
    vi.mocked(harness.registry.listExternalSource).mockResolvedValueOnce({
      items: [],
      browse: { activeMode: 'latest', availableModes: ['popular', 'latest', 'search'] },
    });

    await act(async () => {
      await harness.controller.openFolder({
        ...harness.controller.items[0]!,
        kind: 'folder',
        navigationRef: 'source:9',
        importability: 'unsupported',
        importState: 'unsupported',
      });
    });

    expect(harness.registry.listExternalSource).toHaveBeenLastCalledWith(
      SOURCE_ID,
      expect.anything(),
      expect.objectContaining({ parentRef: 'source:9', browseMode: 'latest', filters: [{ position: 0, value: 1 }] }),
      expect.any(AbortSignal),
    );
    expect(harness.controller.filterValues).toEqual({ '0': 1 });
    await act(async () => harness.renderer.unmount());
  });

  it('adds a work to the library, detects later releases and selects only the new releases', async () => {
    const harness = await createHarness({ downloadedContent: '기존 원격 원문', supportsSubscriptions: true });
    const chapter = (id: number, title: string) => ({
      key: { ...ITEM_KEY, remoteId: `chapter:${id}` },
      kind: 'file' as const,
      title,
      mimeType: 'application/vnd.comicbook+zip',
      formatHint: 'CBZ',
      collection: { remoteId: 'manga:1', title: '연동 작품' },
      release: { title, chapterNumber: id },
      importability: 'supported' as const,
    });
    vi.mocked(harness.registry.listExternalSource).mockResolvedValueOnce({
      detail: { title: '연동 작품', author: '작가', sourceLabel: '테스트 소스' },
      items: [chapter(11, '11화')],
    });
    await act(async () => {
      await harness.controller.openItem({
        ...harness.controller.items[0]!,
        kind: 'work',
        title: '연동 작품',
        navigationRef: 'manga:1',
        importability: 'unsupported',
        importState: 'unsupported',
      });
      await harness.controller.addCurrentWorkToLibrary();
    });

    expect(harness.controller.activeSubscription).toMatchObject({
      title: '연동 작품',
      knownReleaseIds: ['chapter:11'],
      newReleaseIds: [],
    });
    expect(harness.controller.libraryWorks).toEqual([
      expect.objectContaining({ title: '연동 작품', thumbnailUrl: undefined }),
    ]);
    vi.mocked(harness.registry.listExternalSource).mockResolvedValueOnce({
      detail: { title: '연동 작품', author: '작가', sourceLabel: '테스트 소스' },
      items: [chapter(11, '11화'), chapter(12, '12화')],
    });
    await act(async () => {
      await harness.controller.refresh();
    });

    expect(harness.controller.activeSubscription?.newReleaseIds).toEqual(['chapter:12']);
    expect(harness.controller.sources[0]?.newReleaseCount).toBe(1);
    act(() => harness.controller.selectNewReleases());
    expect(harness.controller.items).toMatchObject([
      { key: { remoteId: 'chapter:11' }, selected: false },
      { key: { remoteId: 'chapter:12' }, selected: true },
    ]);
    await act(async () => {
      await harness.controller.acknowledgeNewReleases();
    });
    expect(harness.controller.activeSubscription?.newReleaseIds).toEqual([]);
    await act(async () => harness.renderer.unmount());
  });

  it('adds a browsed Suwayomi work to the library without opening its detail screen', async () => {
    const harness = await createHarness({ downloadedContent: '기존 원격 원문', supportsSubscriptions: true });
    vi.mocked(harness.registry.listExternalSource).mockResolvedValueOnce({
      detail: {
        title: '원클릭 작품',
        author: '작가',
        thumbnailUrl: 'http://localhost:4567/cover.jpg',
        sourceLabel: '테스트 소스',
      },
      items: [
        {
          key: { ...ITEM_KEY, remoteId: 'chapter:1' },
          kind: 'file',
          title: '1화',
          collection: { remoteId: 'manga:quick', title: '원클릭 작품' },
          release: { title: '1화', chapterNumber: 1 },
          importability: 'supported',
        },
      ],
    });

    await act(async () => {
      await harness.controller.addWorkToLibrary({
        key: { ...ITEM_KEY, remoteId: 'manga:quick' },
        kind: 'work',
        title: '원클릭 작품',
        navigationRef: 'manga:quick',
        importability: 'unsupported',
        selected: false,
        importState: 'unsupported',
      });
    });

    expect(harness.controller.detail).toBeUndefined();
    expect(harness.controller.libraryWorks).toEqual([
      expect.objectContaining({
        title: '원클릭 작품',
        thumbnailUrl: 'http://localhost:4567/cover.jpg',
        knownReleaseIds: ['chapter:1'],
      }),
    ]);
    expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining('라이브러리에 추가했습니다'), 'success');
    await act(async () => harness.renderer.unmount());
  });

  it('stores a session-only Suwayomi cover as persistent local image data when adding a work', async () => {
    const harness = await createHarness({ downloadedContent: '기존 원격 원문', supportsSubscriptions: true });
    const previousFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
          }),
      ),
    );
    vi.mocked(harness.registry.listExternalSource).mockResolvedValueOnce({
      detail: {
        title: '표지 저장 작품',
        thumbnailUrl: 'blob:work-cover',
        sourceLabel: '테스트 소스',
      },
      items: [],
    });

    try {
      await act(async () => {
        await harness.controller.addWorkToLibrary({
          key: { ...ITEM_KEY, remoteId: 'manga:cover' },
          kind: 'work',
          title: '표지 저장 작품',
          navigationRef: 'manga:cover',
          importability: 'unsupported',
          selected: false,
          importState: 'unsupported',
        });
      });

      expect(harness.controller.libraryWorks[0]?.thumbnailUrl).toBe('data:image/png;base64,AQID');
      expect(harness.state.saveSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ thumbnailUrl: 'data:image/png;base64,AQID' }),
      );
    } finally {
      vi.stubGlobal('fetch', previousFetch);
      await act(async () => harness.renderer.unmount());
    }
  });

  it('persists the subscribed Suwayomi source cover after the first hosted chapter import', async () => {
    const coverBytes = Uint8Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9WlS8AAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const coverUrl = `data:image/png;base64,${Buffer.from(coverBytes).toString('base64')}`;
    const saveApprovedEnrichmentCover = vi.fn(async (_bookId, input) => ({
      current: {
        id: 'source-cover',
        bookId: _bookId,
        kind: 'cover',
        provenance: 'approved_enrichment',
        status: 'active',
        storageKey: 'source-cover',
        fileName: input.fileName,
        contentType: input.contentType,
        byteLength: input.blob.size,
        contentHash: input.contentHash,
        pixelWidth: input.pixelWidth,
        pixelHeight: input.pixelHeight,
        createdAt: '2026-08-30T00:00:00.000Z',
        activatedAt: '2026-08-30T00:00:00.000Z',
      } satisfies BookAssetMetadata,
      metadataRevision: 1,
    }));
    const assets = {
      getActiveCover: vi.fn(async () => undefined),
      saveApprovedEnrichmentCover,
    } as unknown as BookAssetRepository;
    const previousCreateImageBitmap = globalThis.createImageBitmap;
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }) as unknown as ImageBitmap),
    );
    const timestamp = '2026-08-30T00:00:00.000Z';
    const harness = await createHarness({
      downloadedContent: '',
      downloadedFile: await singlePageComicFile(),
      localBookMissing: true,
      serial: true,
      supportsIncrementalImageSeriesAppend: true,
      supportsExpectedSourceContentHash: true,
      assets,
      subscriptions: [
        {
          id: 'subscription-1',
          connectorId: SOURCE_ID,
          accountConnectionId: 'fixture-account',
          collectionRemoteId: 'manga:1',
          navigationRef: 'manga:1',
          title: '연동 작품',
          thumbnailUrl: coverUrl,
          knownReleaseIds: ['work-1'],
          newReleaseIds: [],
          availableReleaseCount: 1,
          lastCheckedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
          schemaVersion: 1,
        },
      ],
    });

    try {
      await act(async () => {
        await harness.controller.importSelected();
      });

      expect(saveApprovedEnrichmentCover).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          contentType: 'image/png',
          contentHash: integrityHash(coverBytes),
          expectedMetadataRevision: 0,
          fit: 'crop',
        }),
      );
      expect(harness.importFile.mock.calls[0]![0]).not.toHaveProperty('importMode');
      expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining('1개 회차'), 'success');
    } finally {
      vi.stubGlobal('createImageBitmap', previousCreateImageBitmap);
      await act(async () => harness.renderer.unmount());
    }
  });

  it('uploads only a Suwayomi chapter delta when the active importer supports series append', async () => {
    const exportSource = vi.fn(async () => ({ metadata: {} as BookAssetMetadata, blob: new Blob(['old aggregate']) }));
    const assets = {
      exportSource,
      getActiveCover: vi.fn(async () => undefined),
    } as unknown as BookAssetRepository;
    const finalAggregateHash = await sha256('server merged aggregate');
    const harness = await createHarness({
      downloadedContent: '',
      downloadedFile: await singlePageComicFile(),
      serial: true,
      assets,
      supportsIncrementalImageSeriesAppend: true,
      supportsExpectedSourceContentHash: true,
      novelOverrides: {
        format: 'image_archive',
        documentSectionCount: 1,
        sourceFileName: '연동 작품.cbz',
      },
      initialLinkOverrides: { collectionRemoteId: 'manga:1' },
      importedContent: novel({
        format: 'image_archive',
        documentSectionCount: 1,
        sourceFileName: '연동 작품.cbz',
        sourceContentHash: finalAggregateHash,
        activeContentRevisionId: 'content-merged',
      }),
    });

    await act(async () => {
      await harness.controller.importSelected();
    });

    expect(exportSource).not.toHaveBeenCalled();
    const request = harness.importFile.mock.calls[0]![0];
    expect(request).toMatchObject({
      clientBookId: 'book-1',
      importMode: 'append_image_series',
      baseActiveContentRevisionId: 'content-old',
    });
    expect(request.expectedSourceContentHash).toBe(`sha256:${await sha256(await request.file.arrayBuffer())}`);
    const manifest = await readSeriesImageArchiveManifest(request.file);
    expect(manifest).toMatchObject({
      targetBookId: 'book-1',
      chapters: [
        {
          remoteId: 'work-1',
          title: '1화',
          expectedPreviousSourceContentHash: harness.oldHash,
        },
      ],
    });
    expect(harness.currentLink).toMatchObject({
      activeContentRevisionId: 'content-merged',
      importedRemoteRevision: 'remote-r2',
      pendingImport: undefined,
    });
    await act(async () => harness.renderer.unmount());
  });

  it('repairs an importer-resolved pending link from the active aggregate after a restart', async () => {
    const releaseFile = await singlePageComicFile();
    const releaseHash = await sha256(await releaseFile.arrayBuffer());
    const aggregate = await buildSeriesImageArchive({
      collection: { remoteId: 'manga:1', title: '연동 작품' },
      targetBookId: 'book-1',
      chapters: [
        {
          remoteId: 'work-1',
          release: { title: '1화', chapterNumber: 1 },
          remoteRevision: 'remote-r3',
          sourceContentHash: releaseHash,
          file: releaseFile,
        },
      ],
      signal: new AbortController().signal,
    });
    const aggregateHash = await sha256(await aggregate.arrayBuffer());
    const exportSource = vi.fn(async () => ({
      metadata: { contentHash: aggregateHash } as BookAssetMetadata,
      blob: aggregate,
    }));
    const harness = await createHarness({
      downloadedContent: '',
      serial: true,
      assets: { exportSource, getActiveCover: vi.fn(async () => undefined) } as unknown as BookAssetRepository,
      novelOverrides: {
        format: 'image_archive',
        sourceFileName: aggregate.name,
        sourceContentHash: aggregateHash,
        activeContentRevisionId: 'content-merged',
      },
      initialLinkOverrides: {
        collectionRemoteId: 'manga:1',
        pendingImport: {
          operationId: 'interrupted-import',
          stagedAt: '2026-08-30T00:00:00.000Z',
          hadExistingLink: true,
          previousActiveContentRevisionId: 'content-old',
          expectedActiveSourceContentHash: 'uploaded-delta-hash',
          sourceHashResolvedByImporter: true,
          collectionRemoteId: 'manga:1',
          importedRemoteRevision: 'remote-r2',
          importedSourceContentHash: releaseHash,
        },
      },
    });

    expect(exportSource).toHaveBeenCalledWith('book-1');
    expect(harness.currentLink).toMatchObject({
      activeContentRevisionId: 'content-merged',
      importedRemoteRevision: 'remote-r2',
      importedSourceContentHash: releaseHash,
      pendingImport: undefined,
    });
    await act(async () => harness.renderer.unmount());
  });

  it('keeps the full aggregate fallback when the importer cannot append image-series deltas', async () => {
    const existingArchive = await singlePageComicFile();
    const exportSource = vi.fn(async () => ({
      metadata: {} as BookAssetMetadata,
      blob: existingArchive,
    }));
    const harness = await createHarness({
      downloadedContent: '',
      downloadedFile: await singlePageComicFile(),
      serial: true,
      assets: { exportSource, getActiveCover: vi.fn(async () => undefined) } as unknown as BookAssetRepository,
      novelOverrides: { format: 'image_archive', documentSectionCount: 1 },
    });

    await act(async () => {
      await harness.controller.importSelected();
    });

    expect(exportSource).toHaveBeenCalledWith('book-1');
    expect(harness.importFile.mock.calls[0]![0]).not.toHaveProperty('importMode');
    await act(async () => harness.renderer.unmount());
  });

  it('advances only the checked link revision when exact source bytes did not change', async () => {
    const harness = await createHarness({ downloadedContent: '기존 원격 원문' });

    await act(async () => {
      await harness.controller.importSelected();
    });

    expect(harness.confirm).toHaveBeenCalledOnce();
    expect(harness.importFile).not.toHaveBeenCalled();
    expect(harness.saveLink).toHaveBeenCalledOnce();
    expect(harness.currentLink).toMatchObject({
      localBookId: 'book-1',
      importedRemoteRevision: 'remote-r2',
      importedSourceContentHash: harness.oldHash,
      activeContentRevisionId: 'content-old',
    });
    expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining('연결 revision만 갱신했습니다'), 'success');
    await act(async () => harness.renderer.unmount());
  });

  it('imports changed bytes into the existing local book identity', async () => {
    const nextNovel = novel({
      id: 'book-1',
      sourceContentHash: await sha256('변경된 원격 원문'),
      activeContentRevisionId: 'content-new',
    });
    const harness = await createHarness({ downloadedContent: '변경된 원격 원문', importedContent: nextNovel });

    await act(async () => {
      await harness.controller.importSelected();
    });

    expect(harness.importFile).toHaveBeenCalledWith(
      expect.objectContaining({ clientBookId: 'book-1' }),
      expect.any(Function),
    );
    expect(harness.currentLink).toMatchObject({
      localBookId: 'book-1',
      importedRemoteRevision: 'remote-r2',
      activeContentRevisionId: 'content-new',
    });
    expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining('본문을 업데이트했습니다'), 'success');
    await act(async () => harness.renderer.unmount());
  });

  it('does not advance the old link revision when changed content import fails', async () => {
    const harness = await createHarness({
      downloadedContent: '가져오기에 실패할 원격 원문',
      importError: new Error('fixture import failed'),
    });

    await act(async () => {
      await harness.controller.importSelected();
    });

    expect(harness.importFile).toHaveBeenCalledWith(
      expect.objectContaining({ clientBookId: 'book-1' }),
      expect.any(Function),
    );
    expect(harness.saveLink).toHaveBeenCalled();
    expect(harness.currentLink).toMatchObject({
      importedRemoteRevision: 'remote-r1',
      activeContentRevisionId: 'content-old',
    });
    expect(harness.currentLink.pendingImport).toBeUndefined();
    expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining('기존 본문과 연결을 유지했습니다'), 'warning');
    await act(async () => harness.renderer.unmount());
  });

  it('keeps the activated content link when the post-import refresh read fails', async () => {
    const sourceContentHash = await sha256('적용 뒤 조회가 실패할 원문');
    const harness = await createHarness({
      downloadedContent: '적용 뒤 조회가 실패할 원문',
      importedContent: novel({ sourceContentHash, activeContentRevisionId: 'content-new' }),
      getNovelErrorAfterImport: true,
    });

    await act(async () => {
      await harness.controller.importSelected();
    });

    expect(harness.currentLink).toMatchObject({
      importedRemoteRevision: 'remote-r2',
      importedSourceContentHash: sourceContentHash,
      activeContentRevisionId: 'content-new',
    });
    expect(harness.currentLink.pendingImport).toBeUndefined();
    expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining('본문을 업데이트했습니다'), 'success');
    await act(async () => harness.renderer.unmount());
  });

  it('reports cancellation without emitting an empty success toast or advancing the link', async () => {
    const harness = await createHarness({
      downloadedContent: '취소할 원격 원문',
      importError: new DOMException('Aborted', 'AbortError'),
    });

    await act(async () => {
      await harness.controller.importSelected();
    });

    expect(harness.saveLink).toHaveBeenCalled();
    expect(harness.currentLink.importedRemoteRevision).toBe('remote-r1');
    expect(harness.currentLink.pendingImport).toBeUndefined();
    expect(harness.notify).toHaveBeenCalledWith(
      '가져오기를 취소했습니다. 취소된 작품은 기존 본문과 연결을 유지합니다.',
      'warning',
    );
    await act(async () => harness.renderer.unmount());
  });

  it('offers re-import when a persisted link points to a deleted local book', async () => {
    const harness = await createHarness({
      downloadedContent: '복구할 원격 원문',
      localBookMissing: true,
    });

    expect(harness.controller.items[0]?.importState).toBe('available');
    await act(async () => {
      await harness.controller.importSelected();
    });

    expect(harness.confirm).not.toHaveBeenCalled();
    expect(harness.importFile).toHaveBeenCalledWith(
      expect.objectContaining({ clientBookId: 'book-1' }),
      expect.any(Function),
    );
    expect(harness.currentLink.localBookId).toBe('book-1');
    await act(async () => harness.renderer.unmount());
  });
});
