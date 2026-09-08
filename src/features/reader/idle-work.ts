export function scheduleIdleWork(callback: () => void, timeoutMs: number): () => void {
  const requestIdle = globalThis.requestIdleCallback;
  if (typeof requestIdle === 'function') {
    const idleId = requestIdle.call(globalThis, callback, { timeout: timeoutMs });
    return () => {
      const cancelIdle = globalThis.cancelIdleCallback;
      if (typeof cancelIdle === 'function') cancelIdle.call(globalThis, idleId);
    };
  }

  // Safari/WebKit may not expose requestIdleCallback. Keep this optional work
  // behind the current render without making pagination depend on that API.
  const timeoutId = globalThis.setTimeout(callback, Math.min(timeoutMs, 50));
  return () => globalThis.clearTimeout(timeoutId);
}
