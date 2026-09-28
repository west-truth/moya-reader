import { afterEach, expect, it, vi } from 'vitest';
import { sourceLibraryLoad } from './source-library-load';
afterEach(() => vi.useRealTimers());
it('ends stalled reads with a retryable failure and clears its timer', async () => {
  vi.useFakeTimers();
  const promise = sourceLibraryLoad(new Promise(() => {}));
  const rejected = expect(promise).rejects.toThrow('시간이 초과');
  await vi.advanceTimersByTimeAsync(20000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
it('returns a successful storage snapshot without leaving a timeout', async () => {
  vi.useFakeTimers();
  await expect(sourceLibraryLoad(Promise.resolve(['work']))).resolves.toEqual(['work']);
  expect(vi.getTimerCount()).toBe(0);
});
