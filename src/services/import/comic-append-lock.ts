const pendingAppends = new Map<string, Promise<unknown>>();

/** Parts are staged once per book. Web Locks cover tabs/workers; the fallback covers a single runtime. */
export async function withComicAppendLock<T>(bookId: string, work: () => Promise<T>): Promise<T> {
  if (globalThis.navigator?.locks) return navigator.locks.request(`moya-comic-append:${bookId}`, work);
  const previous = pendingAppends.get(bookId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  pendingAppends.set(bookId, current);
  try {
    return await current;
  } finally {
    if (pendingAppends.get(bookId) === current) pendingAppends.delete(bookId);
  }
}
