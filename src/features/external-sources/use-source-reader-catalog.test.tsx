import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExternalCatalogCachePage, ExternalItemPage, ExternalItemSummary } from '../../external-sources/contracts';
import { cachePageId, storedSourcePage } from '../../external-sources/cached-page';
import { useSourceReaderCatalog } from './use-source-reader-catalog';
import { useSourceStreamNavigation } from './use-source-stream-navigation';
import type {
  ExternalSourceController,
  ExternalSourceItemView,
  UseExternalSourceControllerOptions,
} from './useExternalSourceController';

function release(n: number, work = 'work'): ExternalItemSummary {
  return {
    key: { connectorId: 'source', accountConnectionId: 'account', remoteId: `${work}-${n}` },
    kind: 'file',
    title: `${n}화`,
    importability: 'supported',
    collection: { remoteId: work, title: work },
    release: { title: `${n}화`, sourceOrder: n },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function cached(items = [release(1), release(2)], stale = false, completeSeries = true) {
  const input = { parentRef: 'work', accountConnectionId: 'account' };
  return {
    ...storedSourcePage(cachePageId('source', 'account', input, 'local', 'generation'), 'source', input, { items }),
    completeSeries,
    ...(stale ? { expiresAt: '2000-01-01T00:00:00Z' } : {}),
  };
}
async function harness(
  input: { cache?: ExternalCatalogCachePage; detailLoading?: boolean; read?: () => Promise<ExternalItemPage> } = {},
) {
  const pages = new Map<string, ExternalCatalogCachePage>();
  if (input.cache) pages.set(input.cache.id, input.cache);
  let item: ExternalItemSummary | undefined = release(1);
  let detailLoading = input.detailLoading ?? false;
  let account = 'account';
  const read = vi.fn(input.read ?? (async () => ({ items: [release(1), release(2)] })));
  const open = vi.fn(async () => {});
  const options = {
    registry: {
      getExternalSourceStatus: () => ({
        state: 'connected',
        accountConnectionId: account,
        connectionGeneration: 'generation',
      }),
      listExternalSource: read,
    },
    state: {
      getCachePage: async (id: string) => pages.get(id),
      saveCachePage: async (page: ExternalCatalogCachePage) => {
        pages.set(page.id, page);
      },
    },
    hostContext: {},
  } as unknown as UseExternalSourceControllerOptions;
  let catalog!: ReturnType<typeof useSourceReaderCatalog>;
  let navigation!: ReturnType<typeof useSourceStreamNavigation>;
  let renderer!: ReactTestRenderer;
  function Harness() {
    catalog = useSourceReaderCatalog(item, options, detailLoading);
    navigation = useSourceStreamNavigation(
      {
        streaming: item ? { item } : undefined,
        streamCatalog: catalog,
        // The detail screen contains only sparse downloaded chapters, with no cursor.
        items: [1, 9].map(
          (n) =>
            ({
              ...release(n),
              selected: false,
              importState: 'imported',
              localOrderOnly: true,
            }) as ExternalSourceItemView,
        ),
        openStreamItem: open,
      } as unknown as ExternalSourceController,
      false,
    ); // Content prefetch is disabled.
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  return {
    read,
    open,
    pages,
    get catalog() {
      return catalog;
    },
    get navigation() {
      return navigation;
    },
    async update(patch: { item?: ExternalItemSummary; detailLoading?: boolean; account?: string }) {
      if ('item' in patch) item = patch.item;
      if ('detailLoading' in patch) detailLoading = patch.detailLoading!;
      if ('account' in patch) account = patch.account!;
      await act(async () => renderer.update(<Harness />));
    },
    async dispose() {
      await act(async () => renderer.unmount());
    },
  };
}
afterEach(() => vi.useRealTimers());
describe('complete catalog for streamed reader navigation', () => {
  it('uses a fresh complete cache across episode changes and reopening without requests', async () => {
    const h = await harness({ cache: cached() });
    try {
      expect(h.read).not.toHaveBeenCalled();
      expect(h.navigation.nextItem?.key.remoteId).toBe('work-2');
      await h.update({ item: release(2) });
      expect(h.navigation.previous).toBeDefined();
      await h.update({ item: undefined });
      await h.update({ item: release(1) });
      expect(h.read).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  });
  it('waits for the detail request and reuses its saved catalog without a duplicate request', async () => {
    const h = await harness({ detailLoading: true });
    try {
      let moving!: Promise<void>;
      await act(async () => {
        moving = h.navigation.next!();
      });
      expect(h.read).not.toHaveBeenCalled();
      expect(h.open).not.toHaveBeenCalled();
      const page = cached();
      h.pages.set(page.id, page);
      await h.update({ detailLoading: false });
      await moving;
      expect(h.read).not.toHaveBeenCalled();
      expect(h.open).toHaveBeenCalledWith(expect.objectContaining({ key: release(2).key }));
    } finally {
      await h.dispose();
    }
  });
  it('fills an incomplete cache through all cursors even with prefetch off and never skips to downloaded episode 9', async () => {
    const last = deferred<ExternalItemPage>();
    let count = 0;
    const h = await harness({
      cache: cached([release(1), release(9)], false, false),
      read: async () => (++count === 1 ? { items: [release(9), release(2)], nextCursor: 'older' } : last.promise),
    });
    try {
      let moving!: Promise<void>;
      await act(async () => {
        moving = h.navigation.next!();
      });
      expect(h.open).not.toHaveBeenCalled();
      await act(async () => {
        last.resolve({ items: [release(1)] });
      });
      await moving;
      expect(h.read).toHaveBeenCalledTimes(2);
      expect(h.open).toHaveBeenCalledWith(expect.objectContaining({ key: release(2).key }));
      expect([...h.pages.values()][0].completeSeries).toBe(true);
      await h.update({ item: release(2) });
      expect(h.read).toHaveBeenCalledTimes(2);
    } finally {
      await h.dispose();
    }
  });
  it('keeps a complete stale cache usable during a refresh and after an offline failure', async () => {
    const remote = deferred<ExternalItemPage>();
    const h = await harness({
      cache: cached(undefined, true),
      read: async () => {
        await remote.promise;
        throw new Error('offline');
      },
    });
    try {
      expect(h.catalog?.loading).toBe(true);
      expect(h.navigation.nextItem?.key.remoteId).toBe('work-2');
      await act(async () => {
        remote.resolve({ items: [] });
      });
      expect(h.catalog?.error).toBe('offline');
      let moving!: Promise<void>;
      await act(async () => {
        moving = h.navigation.next!();
      });
      await moving;
      expect(h.open).toHaveBeenCalledWith(expect.objectContaining({ key: release(2).key }));
      expect(h.read).toHaveBeenCalledOnce();
    } finally {
      await h.dispose();
    }
  });
  it('retries on next after failure without changing the current episode in the meantime', async () => {
    const h = await harness({
      read: async () => {
        throw new Error('offline');
      },
    });
    try {
      expect(h.catalog?.error).toBe('offline');
      expect(h.open).not.toHaveBeenCalled();
      h.read.mockResolvedValue({ items: [release(1), release(2)] });
      let moving!: Promise<void>;
      await act(async () => {
        moving = h.navigation.next!();
      });
      await moving;
      expect(h.read).toHaveBeenCalledTimes(2);
      expect(h.open).toHaveBeenCalledOnce();
    } finally {
      await h.dispose();
    }
  });
  it('ignores a late result after changing works and does not save it into the new work cache', async () => {
    const remote = deferred<ExternalItemPage>();
    const h = await harness({ read: () => remote.promise });
    try {
      h.read.mockResolvedValue({ items: [release(1, 'other'), release(2, 'other')] });
      await h.update({ item: release(1, 'other') });
      await act(async () => {
        remote.resolve({ items: [release(1), release(9)] });
      });
      expect(h.navigation.nextItem?.key.remoteId).toBe('other-2');
      expect([...h.pages.values()]).toHaveLength(1);
      expect([...h.pages.values()][0].items[0].collection?.remoteId).toBe('other');
    } finally {
      await h.dispose();
    }
  });
  it('does not expose the previous account catalog after a connection change', async () => {
    const h = await harness({ cache: cached() });
    try {
      await h.update({ account: 'different-account' });
      expect(h.catalog?.items).toBeUndefined();
      expect(h.catalog?.error).toContain('해당 소스 계정');
      expect(h.read).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  });
  it('bounds an unresponsive provider and releases a pending next request on failure', async () => {
    vi.useFakeTimers();
    const h = await harness({ read: () => new Promise(() => {}) });
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(h.catalog?.loading).toBe(false);
      expect(h.catalog?.error).toContain('초과');
      let error: unknown;
      await act(async () => {
        void h.navigation.next!().catch((value) => {
          error = value;
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(error).toBeInstanceOf(Error);
      expect(h.navigation.busy).toBe(false);
      expect(h.open).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  });
});
