import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { SyncRepository } from '../../repositories/reader-repository';
import type { ReaderRuntime } from '../../repositories/reader-runtime';
import { useConnectedReaderSync, type ConnectedReaderSyncBindings } from '../../sync/use-connected-reader-sync';
import type { SyncOutboxItem, SyncOutboxQueryOptions, SyncState } from '../../sync/types';
import { useSyncOutboxDetails } from './useSyncOutboxDetails';

const state: SyncState = {
  id: 'sync-state',
  mode: 'local_only',
  status: 'local_only',
  pendingCount: 50_000,
  nextSequence: 50_001,
  updatedAt: '2026-09-05',
};

describe('outbox detail lifecycle', () => {
  it('keeps full review across refreshes, hides stale actions while loading, and resets on close or repository change', async () => {
    const rows = Array.from({ length: 123 }, (_, index) => ({
      id: `item-${index}`,
      localSequence: index,
      status: 'pending',
    })) as SyncOutboxItem[];
    let pendingReload: Promise<SyncOutboxItem[]> | undefined;
    const listSyncOutbox = vi.fn(async (status?: SyncOutboxItem['status'], options?: SyncOutboxQueryOptions) => {
      if (status !== 'pending') return [];
      return pendingReload ?? rows.slice(0, options?.limit);
    });
    const repository: SyncRepository = { listSyncOutbox, getSyncState: vi.fn(async () => state) };
    let details!: ReturnType<typeof useSyncOutboxDetails>;
    function Harness({
      open = true,
      revision,
      source = repository,
    }: {
      open?: boolean;
      revision: string;
      source?: SyncRepository;
    }) {
      details = useSyncOutboxDetails(source, open, revision);
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness revision="initial" />);
    });
    expect(details.truncated).toBe(true);
    await act(async () => {
      await details.loadComplete();
    });
    expect(details.items).toHaveLength(123);
    expect(details.truncated).toBe(false);

    let finishReload!: (items: SyncOutboxItem[]) => void;
    pendingReload = new Promise((resolve) => {
      finishReload = resolve;
    });
    listSyncOutbox.mockClear();
    await act(async () => {
      renderer.update(<Harness revision="position-saved" />);
    });
    expect(details.loading).toBe(true);
    expect(details.items).toEqual([]);
    expect(listSyncOutbox.mock.calls.every(([, options]) => options === undefined)).toBe(true);
    await act(async () => {
      finishReload(rows);
      await pendingReload;
    });
    pendingReload = undefined;
    expect(details.items).toHaveLength(123);
    expect(details.truncated).toBe(false);

    await act(async () => {
      renderer.update(<Harness open={false} revision="position-saved" />);
    });
    await act(async () => {
      renderer.update(<Harness revision="position-saved" />);
    });
    expect(details.truncated).toBe(true);
    await act(async () => {
      await details.loadComplete();
    });
    expect(details.truncated).toBe(false);
    await act(async () => {
      renderer.update(<Harness source={{ ...repository }} revision="position-saved" />);
    });
    expect(details.truncated).toBe(true);
    await act(async () => renderer.unmount());
  });

  it('does not read payloads while closed and discards a detail response after close', async () => {
    let resolve!: (items: SyncOutboxItem[]) => void;
    const pending = new Promise<SyncOutboxItem[]>((done) => {
      resolve = done;
    });
    const repository: SyncRepository = { listSyncOutbox: vi.fn(() => pending), getSyncState: vi.fn(async () => state) };
    let details!: ReturnType<typeof useSyncOutboxDetails>;
    function Harness({ open, revision }: { open: boolean; revision: string }) {
      details = useSyncOutboxDetails(repository, open, revision);
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness open={false} revision="initial" />);
    });
    await act(async () => {
      renderer.update(<Harness open={false} revision="position-saved" />);
    });
    expect(repository.listSyncOutbox).not.toHaveBeenCalled();
    await act(async () => {
      renderer.update(<Harness open revision="position-saved" />);
    });
    expect(repository.listSyncOutbox).toHaveBeenCalledTimes(3);
    await act(async () => {
      renderer.update(<Harness open={false} revision="position-saved" />);
    });
    await act(async () => {
      resolve([{ id: 'stale' } as SyncOutboxItem]);
      await pending;
    });
    expect(details.items).toEqual([]);
    expect(details.loading).toBe(false);
    await act(async () => renderer.unmount());
  });

  it('refreshes local reading progress and bootstrap-style status without loading outbox payloads', async () => {
    const repository = { listSyncOutbox: vi.fn(), getSyncState: vi.fn(async () => state) };
    const runtime = { readerRepository: repository } as unknown as ReaderRuntime;
    const setSyncState = vi.fn();
    let controller!: ReturnType<typeof useConnectedReaderSync>;
    function Harness() {
      controller = useConnectedReaderSync({
        runtime,
        selection: { view: 'library', chapterProgress: 0 },
        serverAttachBusy: false,
        resetParagraphCache: vi.fn(),
        bindings: { setSyncState } as unknown as ConnectedReaderSyncBindings,
      });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => {
      await controller.refreshSyncState();
      await controller.refreshAfterLocalMutation('progress');
      await controller.flushSyncState();
    });
    expect(repository.getSyncState).toHaveBeenCalledTimes(3);
    expect(setSyncState).toHaveBeenLastCalledWith(state);
    expect(repository.listSyncOutbox).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });
});
