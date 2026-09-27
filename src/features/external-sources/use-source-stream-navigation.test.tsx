import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { useSourceStreamNavigation } from './use-source-stream-navigation';
import type { ExternalSourceController, ExternalSourceItemView } from './useExternalSourceController';
function item(n: number) {
  return {
    key: { connectorId: 'fixture', remoteId: String(n) },
    release: { title: `${n}화`, sourceOrder: n },
    importState: 'available',
  } as ExternalSourceItemView;
}
async function harness(prefetch = false) {
  const first = item(1),
    second = item(2);
  let controller = {
    streaming: { item: first },
    items: [first],
    nextCursor: 'p2',
    loadMore: vi.fn(async () => {}),
    importAndOpen: vi.fn(async () => {}),
    closeStream: vi.fn(),
    openImported: vi.fn(async () => {}),
  } as unknown as ExternalSourceController;
  let result!: ReturnType<typeof useSourceStreamNavigation>, renderer!: ReactTestRenderer;
  function Harness() {
    result = useSourceStreamNavigation(controller, prefetch);
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  return {
    first,
    second,
    get controller() {
      return controller;
    },
    get result() {
      return result;
    },
    async update(patch: Partial<ExternalSourceController>) {
      controller = { ...controller, ...patch };
      await act(async () => renderer.update(<Harness />));
    },
    async dispose() {
      await act(async () => renderer.unmount());
    },
  };
}
describe('stream navigation across catalog pages', () => {
  it('prepares a neighbor across catalog cursors without navigating or importing it', async () => {
    const h = await harness(true);
    try {
      expect(h.controller.loadMore).toHaveBeenCalledOnce();
      await h.update({ items: [h.second, h.first], nextCursor: undefined });
      expect(h.result.nextItem).toBe(h.second);
      expect(h.controller.importAndOpen).not.toHaveBeenCalled();
      expect(h.controller.openImported).not.toHaveBeenCalled();
      expect(h.result.busy).toBe(false);
    } finally {
      await h.dispose();
    }
  });

  it('loads another page and navigates in episode order despite descending listings', async () => {
    const h = await harness();
    try {
      vi.mocked(h.controller.loadMore).mockImplementation(async () => {
        await h.update({ items: [h.second, h.first], nextCursor: undefined });
      });
      let pending!: Promise<void>;
      await act(async () => {
        pending = h.result.next!();
      });
      await pending;
      expect(h.controller.loadMore).toHaveBeenCalledOnce();
      expect(h.controller.importAndOpen).toHaveBeenCalledWith(h.second);
    } finally {
      await h.dispose();
    }
  });
  it('retains the current episode when the cursor cannot advance, then allows retry', async () => {
    const h = await harness();
    try {
      let error: unknown;
      await act(async () => {
        void h.result.next!().catch((e) => {
          error = e;
        });
      });
      expect(error).toBeInstanceOf(Error);
      expect(h.controller.importAndOpen).not.toHaveBeenCalled();
      expect(h.result.busy).toBe(false);
      vi.mocked(h.controller.loadMore).mockImplementation(async () => {
        await h.update({ items: [h.first, h.second], nextCursor: undefined });
      });
      let pending!: Promise<void>;
      await act(async () => {
        pending = h.result.next!();
      });
      await pending;
      expect(h.controller.importAndOpen).toHaveBeenCalledWith(h.second);
    } finally {
      await h.dispose();
    }
  });
  it('keeps the current stream when opening a saved neighbor fails and allows retry', async () => {
    const h = await harness();
    try {
      await h.update({ items: [h.first, { ...h.second, importState: 'imported' }], nextCursor: undefined });
      vi.mocked(h.controller.openImported).mockRejectedValueOnce(new Error('saved book missing'));
      let error: unknown;
      await act(async () => {
        void h.result.next!().catch((value) => {
          error = value;
        });
      });
      expect(error).toEqual(new Error('saved book missing'));
      expect(h.controller.closeStream).not.toHaveBeenCalled();
      expect(h.result.busy).toBe(false);
      let pending!: Promise<void>;
      await act(async () => {
        pending = h.result.next!();
      });
      await pending;
      expect(h.controller.closeStream).toHaveBeenCalledOnce();
    } finally {
      await h.dispose();
    }
  });
  it.each(['imported', 'update_available'] as const)(
    'uses the saved reader for %s neighbors and cancels stale automatic navigation',
    async (importState) => {
      const h = await harness();
      try {
        const saved = { ...h.second, importState };
        await h.update({ items: [h.first, saved], nextCursor: undefined });
        let error: unknown;
        await act(async () => {
          void h.result.next!(() => false).catch((e) => {
            error = e;
          });
        });
        expect(error).toBeInstanceOf(Error);
        expect(h.controller.openImported).not.toHaveBeenCalled();
        let pending!: Promise<void>;
        await act(async () => {
          pending = h.result.next!();
        });
        await pending;
        expect(h.controller.openImported).toHaveBeenCalledWith(saved, true);
        expect(h.controller.closeStream).toHaveBeenCalledOnce();
      } finally {
        await h.dispose();
      }
    },
  );
});
