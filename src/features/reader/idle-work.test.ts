import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleIdleWork } from './idle-work';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('scheduleIdleWork', () => {
  it('falls back to a cancellable timer when WebKit does not expose requestIdleCallback', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.stubGlobal('cancelIdleCallback', undefined);
    const callback = vi.fn();

    scheduleIdleWork(callback, 1_500);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('cancels the timer fallback when the page is no longer active', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.stubGlobal('cancelIdleCallback', undefined);
    const callback = vi.fn();

    const cancel = scheduleIdleWork(callback, 1_500);
    cancel();
    vi.runAllTimers();
    expect(callback).not.toHaveBeenCalled();
  });

  it('uses and cancels the native idle callback when it is available', () => {
    const callback = vi.fn();
    const cancelIdleCallback = vi.fn();
    const requestIdleCallback = vi.fn(() => 42);
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);

    const cancel = scheduleIdleWork(callback, 1_500);
    expect(requestIdleCallback).toHaveBeenCalledWith(callback, { timeout: 1_500 });
    cancel();
    expect(cancelIdleCallback).toHaveBeenCalledWith(42);
  });
});
