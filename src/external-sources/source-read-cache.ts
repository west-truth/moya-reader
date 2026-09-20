import { CacheBudget } from '../../packages/extension-runtime/cache-budget.mjs';
import { joinTask } from '../../services/apk-worker/shared-task.mjs';
import { transientSourceFailure } from './cache-policy';
const pool = new CacheBudget<{ value: unknown; fetchedAt: number }>(32 * 1024 * 1024, 1000, 16 * 1024 * 1024);
/** Host-owned JSON cache shared across package formats, with account quotas and independent cancellation. */
export class SourceReadCache {
  private pending = new Map<string, unknown>();
  private lifetime = new AbortController();
  constructor(private owner = Symbol('source-cache')) {}
  async read<T>(
    key: string,
    fresh: number,
    keep: number,
    signal: AbortSignal,
    reload: boolean,
    load: (signal: AbortSignal) => Promise<T>,
  ) {
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    signal.throwIfAborted();
    const entry = pool.get(this.owner, key) as { value: T; fetchedAt: number } | undefined;
    if (!reload && entry && entry.fetchedAt + fresh > Date.now()) return { ...entry, stale: false };
    try {
      return await joinTask(this.pending, key, signal, async (shared) => {
        const value = await load(shared);
        shared.throwIfAborted();
        const fetchedAt = Date.now();
        pool.set(
          this.owner,
          key,
          { value, fetchedAt },
          new TextEncoder().encode(JSON.stringify(value)).length,
          fetchedAt + keep,
        );
        return { value, fetchedAt, stale: false };
      });
    } catch (error) {
      signal.throwIfAborted();
      if (!reload && entry && entry.fetchedAt + keep > Date.now() && transientSourceFailure(error))
        return { ...entry, stale: true };
      throw error;
    }
  }
  clear() {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.pending.clear();
    pool.clear(this.owner);
  }
}
