import { joinTask } from './shared-task.mjs';
import { CacheBudget } from '../../packages/extension-runtime/cache-budget.mjs';
const pool = new CacheBudget(128 * 1024 * 1024, 1000, 64 * 1024 * 1024, 500);
/** Shared process budget with isolated account keys; chapter images never enter this cache. */
export class SourceCoverCache {
  #pending = new Map();
  #owner = Symbol('covers');
  constructor({ maxBytes, maxEntries = 500, ttl = 86400_000, keep = 7 * 86400_000, now = Date.now } = {}) {
    this.pool = maxBytes === undefined ? pool : new CacheBudget(maxBytes, maxEntries);
    Object.assign(this, { ttl, keep, now });
  }
  setOwner(owner) {
    this.clear();
    this.#owner = owner;
  }
  async resolve(key, signal, load) {
    signal.throwIfAborted();
    const found = this.pool.get(this.#owner, key);
    if (found && found.time + this.ttl > this.now()) return found.image;
    try {
      return await joinTask(this.#pending, key, signal, async (sharedSignal) => {
        const image = await load(sharedSignal);
        sharedSignal.throwIfAborted();
        this.pool.set(this.#owner, key, { image, time: this.now() }, image.blob.size, Date.now() + this.keep);
        return image;
      });
    } catch (error) {
      signal.throwIfAborted();
      if (
        found &&
        found.time + this.keep > this.now() &&
        !/(?:401|403|404|410)|auth_|access_denied|generation_changed/i.test(String(error)) &&
        /timeout|network|fetch failed|ECONN|ENET|HTTP (?:429|50[0234])|gateway/i.test(String(error))
      )
        return found.image;
      throw error;
    }
  }
  invalidatePrefix(prefix) {
    for (const [key, entry] of this.#pending)
      if (key.startsWith(prefix)) {
        entry.controller.abort();
        this.#pending.delete(key);
      }
    for (const key of this.pool.keys(this.#owner)) if (key.startsWith(prefix)) this.pool.delete(this.#owner, key);
  }
  clear() {
    for (const entry of this.#pending.values()) entry.controller.abort();
    this.#pending.clear();
    this.pool.clear(this.#owner);
  }
}
