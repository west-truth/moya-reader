import { afterEach, expect, it, vi } from 'vitest';
import { withRequestProgress } from './request-progress';

afterEach(() => vi.useRealTimers());

it('stops polling and ignores late progress after the operation completes', async () => {
  vi.useFakeTimers();
  let finish!: (v: unknown) => void;
  let snapshot!: (v: unknown) => void;
  const request = vi.fn(
    <T>(path: string): Promise<T> =>
      new Promise((resolve) => {
        if (path.includes('/progress/')) snapshot = resolve as (v: unknown) => void;
        else finish = resolve as (v: unknown) => void;
      }),
  );
  const progress = vi.fn();
  const operation = withRequestProgress(
    request as Parameters<typeof withRequestProgress>[0],
    '/work',
    { method: 'POST' },
    1000,
    progress,
  );
  await vi.advanceTimersByTimeAsync(250);
  finish({ ok: true });
  await expect(operation).resolves.toEqual({ ok: true });
  snapshot({ phase: 'uploading', completed: 1, total: 2, unit: 'bytes' });
  await vi.advanceTimersByTimeAsync(10000);
  expect(progress).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(2);
});

it('reports measured progress and stops on abort without replaying the POST', async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  let finish!: (v: unknown) => void;
  const request = vi.fn(<T>(path: string): Promise<T> =>
    path.includes('/progress/')
      ? Promise.resolve({ phase: 'downloading', completed: 12, total: 28, unit: 'images' } as T)
      : new Promise((resolve) => {
          finish = resolve as (v: unknown) => void;
        }),
  );
  const progress = vi.fn();
  const operation = withRequestProgress(
    request as Parameters<typeof withRequestProgress>[0],
    '/work',
    { method: 'POST', signal: abort.signal },
    1000,
    progress,
  );
  await vi.advanceTimersByTimeAsync(250);
  expect(progress).toHaveBeenCalledWith({ phase: 'downloading', completed: 12, total: 28, unit: 'images' });
  abort.abort();
  await vi.advanceTimersByTimeAsync(10000);
  expect(request).toHaveBeenCalledTimes(2);
  finish({ cancelled: true });
  await operation;
});

it('bounds failed telemetry on older servers and keeps the original response', async () => {
  vi.useFakeTimers();
  let finish!: (v: unknown) => void;
  const request = vi.fn(<T>(path: string): Promise<T> =>
    path.includes('/progress/')
      ? Promise.reject(new Error('404'))
      : new Promise((resolve) => {
          finish = resolve as (v: unknown) => void;
        }),
  );
  const operation = withRequestProgress(
    request as Parameters<typeof withRequestProgress>[0],
    '/work',
    { method: 'POST' },
    1000,
    vi.fn(),
  );
  await vi.advanceTimersByTimeAsync(10000);
  expect(request).toHaveBeenCalledTimes(4);
  finish('done');
  await expect(operation).resolves.toBe('done');
});

it('preserves the original request when no observer is attached', async () => {
  const request = vi.fn(async <T>(): Promise<T> => 'done' as T);
  await withRequestProgress(request as Parameters<typeof withRequestProgress>[0], '/work', { method: 'POST' }, 1000);
  expect(request).toHaveBeenCalledExactlyOnceWith('/work', { method: 'POST' }, 1000);
});
