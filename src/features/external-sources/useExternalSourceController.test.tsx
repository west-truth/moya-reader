import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import { sha256 } from '../../domain/hash';
import type { Novel } from '../../domain/types';
import type { ExternalSourceLink } from '../../external-sources/contracts';
import type { ExternalSourceDefaultFolder, ExternalSourceLocalState } from '../../external-sources/local-state';
import type { ImportService } from '../../services/import/import-service';
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
  localBookMissing?: boolean;
  defaultFolder?: ExternalSourceDefaultFolder;
  failFolderRef?: string;
  pickable?: boolean;
}) {
  const oldContent = '기존 원격 원문';
  const oldHash = await sha256(oldContent);
  const currentNovel = novel({ sourceContentHash: oldHash });
  let currentLink: ExternalSourceLink = {
    id: 'external-link::fixture.source::fixture-account::work-1',
    source: ITEM_KEY,
    localBookId: currentNovel.id,
    importedRemoteRevision: 'remote-r1',
    importedSourceContentHash: oldHash,
    activeContentRevisionId: currentNovel.activeContentRevisionId,
    linkedAt: '2026-08-23T00:00:00.000Z',
  };
  const saveLink = vi.fn(async (link: ExternalSourceLink) => {
    currentLink = link;
  });
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
    listSelectedItems: vi.fn(async () => []),
    saveSelectedItem: vi.fn(async () => undefined),
    deleteSelectedItem: vi.fn(async () => undefined),
  };
  let latestImportedNovel: Novel | undefined;
  const importFile = vi.fn<ImportService['importFile']>((request) => {
    latestImportedNovel =
      input.importedContent ??
      novel({
        id: request.clientBookId ?? 'book-new',
        sourceContentHash: 'new-source-hash',
        activeContentRevisionId: 'content-new',
      });
    return {
      jobId: 'import-job',
      cancel: vi.fn(),
      promise: input.importError ? Promise.reject(input.importError) : Promise.resolve({ novel: latestImportedNovel }),
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
          capabilities: ['browse', 'work-import'],
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
        items: [
          {
            key: ITEM_KEY,
            kind: 'work' as const,
            title: 'work.txt',
            mimeType: 'text/plain',
            remoteRevision: 'remote-r2',
            importability: 'supported' as const,
          },
        ],
      };
    }),
    downloadExternalSource: vi.fn(async () => ({
      file: new File([input.downloadedContent], 'work.txt', { type: 'text/plain' }),
      remoteRevision: 'remote-r2',
    })),
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
      importService: { importFile },
      extensionRevision: 0,
      listNovels: async () => (input.localBookMissing ? [] : [currentNovel]),
      getNovel: async (id) =>
        latestImportedNovel?.id === id ? latestImportedNovel : id === currentNovel.id ? currentNovel : undefined,
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
    renderer,
    oldHash,
  };
}

describe('useExternalSourceController remote updates', () => {
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
    expect(harness.saveLink).not.toHaveBeenCalled();
    expect(harness.currentLink).toMatchObject({
      importedRemoteRevision: 'remote-r1',
      activeContentRevisionId: 'content-old',
    });
    expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining('기존 본문과 연결을 유지했습니다'), 'warning');
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

    expect(harness.saveLink).not.toHaveBeenCalled();
    expect(harness.currentLink.importedRemoteRevision).toBe('remote-r1');
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
