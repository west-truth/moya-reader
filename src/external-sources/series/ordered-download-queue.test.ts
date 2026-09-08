import { describe, expect, it, vi } from 'vitest';
import { OrderedDownloadQueue } from './ordered-download-queue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(concurrency = 2, estimate = 1) {
  const abort = new AbortController();
  const pending = Array.from({ length: 6 }, () => deferred<number>());
  const download = vi.fn((index: number, _signal: AbortSignal) => pending[index]!.promise);
  const queue = new OrderedDownloadQueue({
    signal: abort.signal,
    concurrency,
    maxBufferedBytes: 8,
    count: () => pending.length,
    estimateBytes: () => estimate,
    download,
    size: (value: number) => value,
  });
  return { abort, pending, download, queue };
}

describe('ordered download prefetch', () => {
  it('starts two requests, consumes in order, and bounds ready data while storage is stalled', async () => {
    const h = fixture();
    try {
      const first = h.queue.take(0);
      await vi.waitFor(() => expect(h.download).toHaveBeenCalledTimes(2));
      h.pending[1]!.resolve(1);
      expect(h.download).toHaveBeenCalledTimes(2);
      h.pending[0]!.resolve(2);
      expect(await first).toBe(2);
      await vi.waitFor(() => expect(h.download).toHaveBeenCalledTimes(3));
      h.pending[2]!.resolve(3);
      await Promise.resolve();
      // No unbounded replacement of completed requests before ordered consumption.
      expect(h.download).toHaveBeenCalledTimes(3);
      expect(await h.queue.take(1)).toBe(1);
      expect(await h.queue.take(2)).toBe(3);
    } finally {
      h.queue.close();
    }
  });

  it('applies the byte budget to admission and permits one oversized release', async () => {
    const h = fixture(2, 9);
    try {
      const first = h.queue.take(0);
      await vi.waitFor(() => expect(h.download).toHaveBeenCalledOnce());
      h.pending[0]!.resolve(20);
      expect(await first).toBe(20);
      await vi.waitFor(() => expect(h.download).toHaveBeenCalledTimes(2));
      expect(h.download.mock.calls.map(([index]) => index)).toEqual([0, 1]);
    } finally {
      h.queue.close();
    }
  });

  it('respects a single-download source while overlapping download with caller storage', async () => {
    const h = fixture(1);
    try {
      const first = h.queue.take(0);
      await vi.waitFor(() => expect(h.download).toHaveBeenCalledOnce());
      h.pending[0]!.resolve(1);
      await first;
      await vi.waitFor(() => expect(h.download).toHaveBeenCalledTimes(2));
    } finally {
      h.queue.close();
    }
  });

  it('uses actual ready bytes when the provider underestimated the size', async () => {
    const h = fixture();
    try {
      const first = h.queue.take(0);
      await vi.waitFor(() => expect(h.download).toHaveBeenCalledTimes(2));
      h.pending[1]!.resolve(20);
      await Promise.resolve();
      h.pending[0]!.resolve(1);
      await first;
      expect(h.download).toHaveBeenCalledTimes(2);
      expect(await h.queue.take(1)).toBe(20);
    } finally {
      h.queue.close();
    }
  });

  it('holds a later failure until earlier content is consumed, without starting more work', async () => {
    const h = fixture();
    try {
      const first = h.queue.take(0);
      await vi.waitFor(() => expect(h.download).toHaveBeenCalledTimes(2));
      h.pending[1]!.reject(new Error('second failed'));
      await Promise.resolve();
      h.pending[0]!.resolve(1);
      expect(await first).toBe(1);
      await expect(h.queue.take(1)).rejects.toThrow('second failed');
      expect(h.download).toHaveBeenCalledTimes(2);
    } finally {
      h.queue.close();
    }
  });

  it('aborts all active requests and releases the consumer even if a provider ignores abort', async () => {
    const h = fixture();
    const first = h.queue.take(0);
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(h.download).toHaveBeenCalledTimes(2));
    h.abort.abort();
    await rejected;
    expect(h.download.mock.calls.every(([, signal]) => signal.aborted)).toBe(true);
    h.pending[0]!.resolve(1);
    h.pending[1]!.reject(new Error('late provider failure'));
    await Promise.resolve();
    expect(h.download).toHaveBeenCalledTimes(2);
  });

  it('accepts appended selections without downloading previous entries again', async () => {
    const h = fixture();
    h.pending.splice(1);
    try {
      const first = h.queue.take(0);
      await vi.waitFor(() => expect(h.download).toHaveBeenCalledOnce());
      h.pending.push(deferred<number>());
      h.pending[0]!.resolve(1);
      await first;
      await vi.waitFor(() => expect(h.download).toHaveBeenCalledTimes(2));
      h.pending[1]!.resolve(2);
      expect(await h.queue.take(1)).toBe(2);
    } finally {
      h.queue.close();
    }
  });

  it('overlaps controlled 100ms downloads and 50ms sequential commits (400ms vs 900ms)', async () => {
    vi.useFakeTimers();
    let active = 0,
      peak = 0;
    const commits: number[] = [];
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const queue = new OrderedDownloadQueue({
      signal: new AbortController().signal,
      concurrency: 2,
      maxBufferedBytes: 8,
      count: () => 6,
      estimateBytes: () => 1,
      size: () => 1,
      download: async (index) => {
        peak = Math.max(peak, ++active);
        await delay(100);
        active--;
        return index;
      },
    });
    const start = Date.now();
    try {
      const run = (async () => {
        for (let index = 0; index < 6; index++) {
          const value = await queue.take(index);
          await delay(50);
          commits.push(value);
        }
      })();
      await vi.runAllTimersAsync();
      await run;
      expect(commits).toEqual([0, 1, 2, 3, 4, 5]);
      expect(peak).toBe(2);
      expect(Date.now() - start).toBe(400);
    } finally {
      queue.close();
      vi.useRealTimers();
    }
  });
});
