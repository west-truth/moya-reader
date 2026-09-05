import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import { externalItemKeyId } from '../../external-sources/contracts';
import type {
  ExternalItemPage,
  ExternalCatalogCachePage,
  ExternalItemSummary,
  ExternalSourceLink,
  ExternalSourceListInput,
} from '../../external-sources/contracts';
import {
  externalSourceSubscriptionId,
  type ExternalSourceLocalState,
  type ExternalSourceSubscriptionRecord,
} from '../../external-sources/local-state';
import { testChapter, testNovel } from '../book-workspace/book-workspace-test-fixtures';
import { externalItemSectionId } from './serial-work-projection';
import {
  useExternalSourceController,
  type ExternalSourceController,
  type ExternalSourceRegistryPort,
} from './useExternalSourceController';

const sourceId = 'fixture.source' as ExtensionContributionId;
const otherSourceId = 'fixture.other' as ExtensionContributionId;
const now = '2026-09-05T00:00:00.000Z';
function release(id: number, format: 'txt' | 'image_archive' = 'txt'): ExternalItemSummary {
  return {
    key: { connectorId: sourceId, accountConnectionId: 'account', remoteId: `release-${id}` },
    kind: 'file',
    title: `${id}화`,
    importability: 'supported',
    collection: {
      remoteId: 'work',
      title: 'Work',
      ...(format === 'txt'
        ? {
            seriesProfile: {
              kind: 'document_series' as const,
              format: 'txt' as const,
              encoding: 'utf-8' as const,
              chapterSplitMode: 'single' as const,
            },
          }
        : {}),
    },
    release: { title: `${id}화`, sourceOrder: id },
  };
}
function subscription(connectorId: string): ExternalSourceSubscriptionRecord {
  return {
    id: externalSourceSubscriptionId(connectorId, 'account', 'work'),
    connectorId,
    accountConnectionId: 'account',
    collectionRemoteId: 'work',
    navigationRef: 'work',
    title: 'Work',
    knownReleaseIds: [],
    newReleaseIds: [],
    availableReleaseCount: 0,
    createdAt: now,
    updatedAt: now,
    lastCheckedAt: now,
    schemaVersion: 1,
  };
}

async function fixture(format: 'txt' | 'image_archive' = 'txt') {
  const novel = testNovel({ id: 'book', format, documentSectionCount: 3 });
  const otherNovel = testNovel({ id: 'other-book', format: 'txt', documentSectionCount: 1 });
  const chapters = [1, 2, 3].map((id) =>
    testChapter(id, {
      novelId: novel.id,
      documentSectionId: externalItemSectionId(release(id, format)),
      documentSectionTitle: `${id}화`,
      documentSectionIndex: id,
    }),
  );
  const links: ExternalSourceLink[] = [1, 2, 3].map((id) => ({
    id: `link-${id}`,
    source: release(id, format).key,
    localBookId: novel.id,
    collectionRemoteId: 'work',
    linkedAt: now,
  }));
  links.push({
    id: 'other-link',
    source: { connectorId: otherSourceId, accountConnectionId: 'account', remoteId: 'other-release' },
    localBookId: otherNovel.id,
    collectionRemoteId: 'work',
    linkedAt: now,
  });
  let records: ExternalSourceSubscriptionRecord[] = [];
  const listLinks = vi.fn(async (id?: string) => links.filter((link) => !id || link.source.connectorId === id));
  const cachedPages = new Map<string, ExternalCatalogCachePage>();
  const state = {
    listLinks,
    listSubscriptions: vi.fn(async (id?: string, account?: string) =>
      records.filter(
        (record) => (!id || record.connectorId === id) && (!account || record.accountConnectionId === account),
      ),
    ),
    saveSubscription: vi.fn(async (record: ExternalSourceSubscriptionRecord) => {
      records = [...records.filter((entry) => entry.id !== record.id), record];
    }),
    getDefaultFolder: vi.fn(async () => undefined),
    getCatalogPreference: vi.fn(async () => undefined),
    getCachePage: vi.fn(async (id: string) => cachedPages.get(id)),
    saveCachePage: vi.fn(async (page: ExternalCatalogCachePage) => {
      cachedPages.set(page.id, page);
    }),
  } as unknown as ExternalSourceLocalState;
  let page: (cursor?: string, parentRef?: string) => Promise<ExternalItemPage> = async () => ({
    detail: { title: 'Work' },
    items: [release(1, format)],
  });
  let generation = 'initial';
  const download = vi.fn();
  const registry = {
    getExternalSources: () =>
      [sourceId, otherSourceId].map((id) => ({
        descriptor: {
          id,
          schemaVersion: 1,
          title: id,
          kind: 'catalog',
          capabilities: ['browse', 'subscriptions'],
          runtimes: ['web-direct'],
        },
      })),
    getExternalSourceStatus: () => ({
      state: 'connected',
      accountConnectionId: 'account',
      connectionGeneration: generation,
    }),
    listExternalSource: vi.fn(async (_id: string, _host: unknown, input: ExternalSourceListInput) =>
      page(input.cursor, input.parentRef),
    ),
    disconnectExternalSource: vi.fn(async () => undefined),
    downloadExternalSource: download,
  } as unknown as ExternalSourceRegistryPort;
  const notify = vi.fn();
  let controller!: ExternalSourceController;
  let renderer!: ReactTestRenderer;
  function Harness() {
    controller = useExternalSourceController({
      registry,
      hostContext: { brokers: { get: () => undefined } },
      state,
      importService: { importFile: vi.fn() },
      extensionRevision: 0,
      listNovels: async () => [novel, otherNovel],
      listChapters: async () => chapters,
      getNovel: async (id) => (id === novel.id ? novel : otherNovel),
      openNovel: vi.fn(async () => undefined),
      onLibraryChanged: vi.fn(async () => undefined),
      notify,
      confirm: () => true,
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  return {
    get controller() {
      return controller;
    },
    renderer,
    novel,
    chapters,
    state,
    listLinks,
    download,
    registry,
    cachedPages,
    notify,
    setPage(value: typeof page) {
      page = value;
    },
    setSubscriptions(value: ExternalSourceSubscriptionRecord[]) {
      records = value;
    },
    changeGeneration() {
      generation = 'changed';
    },
  };
}

describe('source series pagination integration', () => {
  it('publishes the first complete snapshot once, reuses it without requests, and stages background changes', async () => {
    const h = await fixture();
    let finish!: () => void;
    let gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    h.setPage(async (cursor) => {
      if (cursor) {
        await gate;
        return { items: [release(2), release(1)] };
      }
      return { detail: { title: 'Work' }, items: [release(9), release(8)], nextCursor: 'older' };
    });
    let pending!: Promise<void>;
    try {
      await act(async () => {
        pending = h.controller.showLocalSeries(h.novel);
        await vi.waitFor(() => expect(h.registry.listExternalSource).toHaveBeenCalledTimes(2));
      });
      expect(h.controller.loading).toBe(true);
      expect(h.controller.items.map((item) => item.key.remoteId)).toEqual(['release-1', 'release-2', 'release-3']);
      finish();
      await act(async () => pending);
      expect(h.controller.loading).toBe(false);
      const initialKeys = h.controller.items.map((item) => item.key.remoteId);
      expect(initialKeys).toEqual(['release-9', 'release-8', 'release-2', 'release-1', 'release-3']);
      await act(async () => h.controller.close());
      await act(async () => h.controller.showLocalSeries(h.novel));
      expect(h.registry.listExternalSource).toHaveBeenCalledTimes(2);
      for (const [id, entry] of h.cachedPages) h.cachedPages.set(id, { ...entry, expiresAt: '2000-01-01T00:00:00Z' });
      gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      h.setPage(async (cursor) =>
        cursor
          ? (await gate, { items: [release(2), release(1)] })
          : { detail: { title: 'Work' }, items: [release(10), release(9), release(8)], nextCursor: 'older' },
      );
      await act(async () => {
        pending = h.controller.showLocalSeries(h.novel);
        await vi.waitFor(() => expect(h.registry.listExternalSource).toHaveBeenCalledTimes(4));
      });
      expect(h.controller.loading).toBe(false);
      expect(h.controller.catalogLoading).toBe(true);
      expect(h.controller.items.map((item) => item.key.remoteId)).toEqual(initialKeys);
      finish();
      await act(async () => pending);
      expect(h.controller.catalogUpdateAvailable).toBe(true);
      expect(h.controller.items.map((item) => item.key.remoteId)).toEqual(initialKeys);
      await act(async () => h.controller.applyCatalogUpdate?.());
      expect(h.controller.items[0]!.key.remoteId).toBe('release-10');
      expect(h.download).not.toHaveBeenCalled();
    } finally {
      finish();
      await pending;
      await act(async () => h.renderer.unmount());
    }
  });
  it('preserves selections on other pages and excludes saved releases from page selection', async () => {
    const h = await fixture();
    h.setPage(async () => ({ detail: { title: 'Work' }, items: [1, 2, 3, 4, 5, 6].map((id) => release(id)) }));
    await act(async () => h.controller.showLocalSeries(h.novel));
    const keys = h.controller.items.map((item) => externalItemKeyId(item.key));
    await act(async () => h.controller.selectAllSupported(true, keys.slice(0, 4)));
    expect(h.controller.items.filter((item) => item.selected).map((item) => item.key.remoteId)).toEqual(['release-4']);
    await act(async () => h.controller.selectAllSupported(true, keys.slice(4)));
    await act(async () => h.controller.selectAllSupported(false, [keys[3]!]));
    expect(h.controller.items.filter((item) => item.selected).map((item) => item.key.remoteId)).toEqual([
      'release-5',
      'release-6',
    ]);
    await act(async () => h.controller.selectAllSupported(false));
    expect(h.controller.items.some((item) => item.selected)).toBe(false);
    await act(async () => h.renderer.unmount());
  });

  it.each(['txt', 'image_archive'] as const)(
    'projects saved read states when opening %s through the source catalog',
    async (format) => {
      const h = await fixture(format);
      h.chapters[0]!.documentSectionReadAt = now;
      h.setPage(async () => ({ detail: { title: 'Work' }, items: [1, 2, 3].map((id) => release(id, format)) }));
      await act(async () => h.controller.show(sourceId));
      await act(async () =>
        h.controller.openItem({
          key: { connectorId: sourceId, remoteId: 'work' },
          kind: 'work',
          title: 'Work',
          navigationRef: 'work',
          importability: 'unsupported',
          importState: 'unsupported',
          selected: false,
        }),
      );
      expect(h.controller.items[0]!.readingState).toBe('read');
      expect(h.controller.items[1]!.readingState).toBe('unread');
      expect(h.download).not.toHaveBeenCalled();
      await act(async () => h.renderer.unmount());
    },
  );
  it.each(['txt', 'image_archive'] as const)(
    'retains all downloaded %s releases across remote refresh/pages/errors',
    async (format) => {
      const h = await fixture(format);
      await act(async () => h.controller.showLocalSeries(h.novel));
      expect(h.controller.items.map((item) => item.key.remoteId)).toEqual(['release-1', 'release-2', 'release-3']);
      h.setPage(async () => ({ detail: { title: 'Work' }, items: [release(2, format), release(4, format)] }));
      await act(async () => h.controller.refresh());
      expect(h.controller.catalogUpdateAvailable).toBe(true);
      await act(async () => h.controller.applyCatalogUpdate?.());
      expect(h.controller.items.map((item) => item.key.remoteId)).toEqual([
        'release-2',
        'release-4',
        'release-1',
        'release-3',
      ]);
      h.setPage(async () => {
        throw new Error('offline');
      });
      await act(async () => h.controller.refresh());
      expect(h.controller.items.map((item) => item.key.remoteId)).toEqual([
        'release-2',
        'release-4',
        'release-1',
        'release-3',
      ]);
      expect(h.download).not.toHaveBeenCalled();
      await act(async () => h.renderer.unmount());
    },
  );

  it('does not mark older pages new, then detects later pages against the complete baseline', async () => {
    const h = await fixture();
    let added = false;
    h.setPage(async (cursor) => ({
      detail: { title: 'Work' },
      items: (cursor ? (added ? [3, 4, 5] : [3, 4]) : [1, 2]).map((id) => release(id)),
      nextCursor: cursor ? undefined : 'older',
    }));
    await act(async () => h.controller.selectSource(sourceId));
    await act(async () =>
      h.controller.openItem({
        key: { connectorId: sourceId, remoteId: 'work' },
        kind: 'work',
        title: 'Work',
        navigationRef: 'work',
        importability: 'unsupported',
        importState: 'unsupported',
        selected: false,
      }),
    );
    await act(async () => h.controller.addCurrentWorkToLibrary());
    expect(h.controller.activeSubscription?.releaseBaselineComplete).toBe(true);
    await act(async () => h.controller.loadMore());
    expect(h.controller.activeSubscription).toMatchObject({ newReleaseIds: [], availableReleaseCount: 4 });
    await act(async () => h.controller.checkSubscriptions());
    expect(h.controller.activeSubscription).toMatchObject({
      releaseBaselineComplete: true,
      newReleaseIds: [],
      availableReleaseCount: 4,
    });
    added = true;
    await act(async () => h.controller.checkSubscriptions());
    expect(h.controller.activeSubscription).toMatchObject({ newReleaseIds: ['release-5'], availableReleaseCount: 5 });
    await act(async () => h.controller.refresh());
    expect(h.controller.activeSubscription).toMatchObject({ newReleaseIds: ['release-5'], availableReleaseCount: 5 });
    expect(h.download).not.toHaveBeenCalled();
    await act(async () => h.renderer.unmount());
  });

  it('keeps other-source library links when opening, refreshing and disconnecting one source', async () => {
    const h = await fixture();
    h.setSubscriptions([subscription(sourceId), subscription(otherSourceId)]);
    await act(async () => h.controller.selectSource(sourceId));
    expect(h.controller.libraryWorks.find((work) => work.connectorId === otherSourceId)?.localBookId).toBe(
      'other-book',
    );
    await act(async () => h.controller.showLocalSeries(h.novel));
    expect(h.controller.libraryWorks.find((work) => work.connectorId === otherSourceId)?.localBookId).toBe(
      'other-book',
    );
    await act(async () => h.controller.disconnect());
    expect(h.controller.libraryWorks.find((work) => work.connectorId === otherSourceId)?.localBookId).toBe(
      'other-book',
    );
    expect(h.listLinks.mock.calls.every((args) => args.length === 0)).toBe(true);
    await act(async () => h.renderer.unmount());
  });

  it('does not publish a late page after connection generation changes', async () => {
    const h = await fixture();
    await act(async () => h.controller.showLocalSeries(h.novel));
    h.setPage(async () => {
      h.changeGeneration();
      return { detail: { title: 'Other account' }, items: [release(9)] };
    });
    await act(async () => h.controller.refresh());
    expect(h.controller.items.map((item) => item.key.remoteId)).toEqual(['release-1', 'release-2', 'release-3']);
    expect(h.controller.detail?.title).toBe('Work');
    await act(async () => h.renderer.unmount());
  });

  it('caps one subscription check at 50 metadata pages and starts with deferred works next time', async () => {
    const h = await fixture();
    await act(async () => h.controller.showLocalSeries(h.novel));
    h.setSubscriptions(
      Array.from({ length: 4 }, (_, index) => ({
        ...subscription(sourceId),
        id: `subscription-${index}`,
        collectionRemoteId: `work-${index}`,
        navigationRef: `work-${index}`,
      })),
    );
    await act(async () => h.controller.refresh());
    const requests: string[] = [];
    h.setPage(async (cursor, parentRef) => {
      requests.push(parentRef!);
      const index = Number(cursor ?? 0);
      return { detail: { title: 'Work' }, items: [release(index)], nextCursor: String(index + 1) };
    });
    await act(async () => h.controller.checkSubscriptions());
    expect(requests).toHaveLength(50);
    expect(requests).not.toContain('work-3');
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('미완료'), 'warning');
    requests.length = 0;
    await act(async () => h.controller.checkSubscriptions());
    expect(requests).toHaveLength(50);
    expect(requests[0]).toBe('work-3');
    expect(h.download).not.toHaveBeenCalled();
    await act(async () => h.renderer.unmount());
  });
});
