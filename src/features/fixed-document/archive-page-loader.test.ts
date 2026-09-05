import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchivePageLoader, type ArchivePageSnapshot, type LoadedArchivePage } from './archive-page-loader';

function harness(options: { automaticAbort?: boolean; cacheSize?: number } = {}) {
  const requests: Array<{
    index: number;
    signal: AbortSignal;
    resolve: (page: LoadedArchivePage) => void;
    reject: (error: Error) => void;
  }> = [];
  let snapshot: ArchivePageSnapshot = { pages: new Map(), errors: new Map() };
  const loader = new ArchivePageLoader(
    (index, signal) =>
      new Promise((resolve, reject) => {
        requests.push({ index, signal, resolve, reject });
        if (options.automaticAbort)
          signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
      }),
    (next) => {
      snapshot = next;
    },
    3,
    options.cacheSize ?? 20,
  );
  return { loader, requests, snapshot: () => snapshot };
}

const page = (index: number): LoadedArchivePage => ({ blob: new Blob([String(index)]) });
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe('archive foreground image loading', () => {
  beforeEach(() => {
    let sequence = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${++sequence}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes the foreground image before slow neighbours and isolates prefetch failures', async () => {
    const h = harness();
    h.loader.update(10, [8, 9, 10, 11, 12]);
    expect(h.requests.map((request) => request.index)).toEqual([10, 8, 9]);
    h.requests[0]!.resolve({ ...page(10), hint: { doublePage: true } });
    await settle();
    expect(h.snapshot().pages.get(10)).toMatchObject({ url: 'blob:test-1', hint: { doublePage: true } });
    expect(h.snapshot().pages.size).toBe(1);
    h.requests[1]!.reject(new Error('Neighbour unavailable'));
    await settle();
    expect(h.snapshot().pages.has(10)).toBe(true);
    expect(h.snapshot().errors.has(10)).toBe(false);
    expect(h.snapshot().errors.get(8)).toBe('Neighbour unavailable');
    h.loader.dispose();
  });

  it('keeps at most three unresolved loads and discards all intermediate seek queues', async () => {
    const h = harness();
    h.loader.update(2, [0, 1, 2, 3, 4]);
    for (let i = 1; i <= 30; i += 1) h.loader.update(i * 20, [i * 20 - 1, i * 20, i * 20 + 1]);
    expect(h.requests).toHaveLength(3);
    expect(h.requests.every((request) => request.signal.aborted)).toBe(true);
    // Even a backend that completes after cancellation cannot publish stale data.
    for (const request of h.requests.slice()) request.resolve(page(request.index));
    await settle();
    expect(h.requests.slice(3).map((request) => request.index)).toEqual([600, 599, 601]);
    expect(h.snapshot().pages.size).toBe(0);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    h.loader.dispose();
  });

  it('starts the latest destination as soon as aborted requests settle', async () => {
    const h = harness({ automaticAbort: true });
    h.loader.update(2, [0, 1, 2, 3, 4]);
    h.loader.update(50, [48, 49, 50, 51, 52]);
    await settle();
    expect(h.requests.slice(3).map((request) => request.index)).toEqual([50, 48, 49]);
    expect(h.snapshot().errors.size).toBe(0);
    h.loader.dispose();
  });

  it('preempts a still-wanted prefetch for a new foreground page and reuses overlapping loads', async () => {
    const h = harness({ automaticAbort: true });
    h.loader.update(10, [8, 9, 10, 11, 12]);
    h.loader.update(11, [8, 9, 10, 11, 12]);
    await settle();
    expect(h.requests[3]!.index).toBe(11);
    expect(h.requests.filter((request) => request.index === 8)).toHaveLength(1);
    expect(h.requests.filter((request) => request.index === 10)).toHaveLength(1);
    h.loader.dispose();
  });

  it('retries a failed prefetch when it becomes the foreground page', async () => {
    const h = harness();
    h.loader.update(10, [10, 11]);
    h.requests[1]!.reject(new Error('Temporary failure'));
    await settle();
    h.loader.update(11, [10, 11]);
    expect(h.snapshot().errors.has(11)).toBe(false);
    expect(h.requests.filter((request) => request.index === 11)).toHaveLength(2);
    h.loader.dispose();
  });

  it('reuses ready images and revokes evicted URLs and all remaining URLs on dispose', async () => {
    const h = harness({ cacheSize: 2 });
    for (const index of [0, 1, 2]) {
      h.loader.update(index, [index]);
      h.requests.at(-1)!.resolve(page(index));
      await settle();
    }
    expect(h.snapshot().pages.size).toBe(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-1');
    h.loader.update(1, [1]);
    expect(h.requests).toHaveLength(3);
    h.loader.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
    h.loader.update(5, [5]);
    expect(h.requests).toHaveLength(3);
  });
});
