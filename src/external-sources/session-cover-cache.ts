interface Entry {
  url: string;
  bytes: number;
}
/** Shared blob ownership for installed source adapters. Visible images cannot be evicted. */
export class SessionCoverCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<string | undefined>>();
  private failures = new Map<string, { time: number; error: unknown }>();
  private lifetime = new AbortController();
  async resolve(
    key: string,
    load: (signal: AbortSignal) => Promise<Blob | undefined>,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    signal.throwIfAborted();
    const found = this.entries.get(key);
    if (found) {
      this.entries.delete(key);
      this.entries.set(key, found);
      return found.url;
    }
    const failure = this.failures.get(key);
    if (failure && Date.now() - failure.time < 30_000) throw failure.error;
    this.failures.delete(key);
    let request = this.pending.get(key);
    if (!request) {
      const generation = this.lifetime;
      const operation = AbortSignal.any([generation.signal, AbortSignal.timeout(30_000)]);
      request = (async () => {
        const blob = await load(operation);
        operation.throwIfAborted();
        if (!blob) return undefined;
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type) || blob.size > 16 * 1024 * 1024)
          throw new Error('invalid_source_cover');
        this.trim(blob.size);
        const url = URL.createObjectURL(blob);
        this.entries.set(key, { url, bytes: blob.size });
        return url;
      })();
      request = request.catch((error) => {
        if (!generation.signal.aborted) {
          if (this.failures.size >= 200) this.failures.delete(this.failures.keys().next().value!);
          this.failures.set(key, { time: Date.now(), error });
        }
        throw error;
      });
      this.pending.set(key, request);
      void request
        .finally(() => {
          if (this.pending.get(key) === request) this.pending.delete(key);
        })
        .catch(() => undefined);
    }
    // Each consumer may leave independently; the shared bounded request can finish for other consumers.
    return new Promise((resolve, reject) => {
      const cancel = () => {
        cleanup();
        reject(signal.reason);
      };
      const cleanup = () => signal.removeEventListener('abort', cancel);
      signal.addEventListener('abort', cancel, { once: true });
      request.then(
        (url) => {
          cleanup();
          if (signal.aborted) reject(signal.reason);
          else resolve(url);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }
  private trim(incoming: number) {
    let bytes = [...this.entries.values()].reduce((n, e) => n + e.bytes, 0);
    const visible = new Set(typeof document === 'undefined' ? [] : Array.from(document.images).map((img) => img.src));
    for (const [key, entry] of this.entries) {
      if (this.entries.size < 200 && bytes + incoming <= 32 * 1024 * 1024) break;
      if (visible.has(entry.url)) continue;
      URL.revokeObjectURL(entry.url);
      this.entries.delete(key);
      bytes -= entry.bytes;
    }
  }
  clear() {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    for (const entry of this.entries.values()) URL.revokeObjectURL(entry.url);
    this.failures.clear();
    this.entries.clear();
    this.pending.clear();
  }
}
