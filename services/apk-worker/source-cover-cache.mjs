import { joinTask } from './shared-task.mjs';

/** Account/catalog-owned memory cache. Only validated cover assets enter it, never chapter images. */
export class SourceCoverCache {
  #entries = new Map();
  #pending = new Map();
  #bytes = 0;
  constructor({ maxBytes = 32 * 1024 * 1024, maxEntries = 200, ttl = 10 * 60 * 1000, now = Date.now } = {}) {
    Object.assign(this, { maxBytes, maxEntries, ttl, now });
  }
  async resolve(key, signal, load) {
    signal.throwIfAborted();
    const found = this.#entries.get(key);
    if (found) {
      this.#entries.delete(key);
      if (found.expires > this.now()) {
        this.#entries.set(key, found);
        return found.image;
      }
      this.#bytes -= found.image.blob.size;
    }
    return joinTask(this.#pending, key, signal, async (sharedSignal) => {
      const image = await load(sharedSignal);
      sharedSignal.throwIfAborted();
      if (image.blob.size <= this.maxBytes) {
        while (
          this.#entries.size &&
          (this.#entries.size >= this.maxEntries || this.#bytes + image.blob.size > this.maxBytes)
        ) {
          const oldest = this.#entries.keys().next().value;
          this.#bytes -= this.#entries.get(oldest).image.blob.size;
          this.#entries.delete(oldest);
        }
        this.#entries.set(key, { image, expires: this.now() + this.ttl });
        this.#bytes += image.blob.size;
      }
      return image;
    });
  }
  clear() {
    for (const entry of this.#pending.values()) entry.controller.abort();
    this.#pending.clear();
    this.#entries.clear();
    this.#bytes = 0;
  }
}
