import { COVER_FRESH_MS, COVER_KEEP_MS, transientSourceFailure } from './cache-policy';
interface Entry {
  url: string;
  bytes: number;
  time: number;
}
/** Shared blob ownership for installed source adapters. Visible images cannot be evicted. */
export class SessionCoverCache {
  private entries = new Map<string, Entry>();
  private retired = new Map<string, Entry>();
  private operations = new Map<string, AbortController>();
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
      if (found.time + COVER_FRESH_MS > Date.now()) return found.url;
    }
    const retained = found && found.time + COVER_KEEP_MS > Date.now() ? found : undefined;
    const failure = this.failures.get(key);
    if (failure && Date.now() - failure.time < 30_000) {
      if (retained && transientSourceFailure(failure.error)) return retained.url;
      throw failure.error;
    }
    this.failures.delete(key);
    let request = this.pending.get(key);
    if (!request) {
      const generation = this.lifetime;
      const local = new AbortController();
      this.operations.set(key, local);
      const operation = AbortSignal.any([generation.signal, local.signal, AbortSignal.timeout(30_000)]);
      request = (async () => {
        const blob = await load(operation);
        operation.throwIfAborted();
        if (!blob) return undefined;
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type) || blob.size > 16 * 1024 * 1024)
          throw new Error('invalid_source_cover');
        const previous = this.entries.get(key);
        if (previous) {
          this.entries.delete(key);
          this.retired.set(previous.url, previous);
        }
        this.trim(blob.size);
        const url = URL.createObjectURL(blob);
        this.entries.set(key, { url, bytes: blob.size, time: Date.now() });
        return url;
      })();
      request = request.catch((error) => {
        if (!generation.signal.aborted && !local.signal.aborted) {
          if (this.failures.size >= 200) this.failures.delete(this.failures.keys().next().value!);
          this.failures.set(key, { time: Date.now(), error });
        }
        throw error;
      });
      this.pending.set(key, request);
      void request
        .finally(() => {
          if (this.pending.get(key) === request) {
            this.pending.delete(key);
            this.operations.delete(key);
          }
        })
        .catch(() => undefined);
    }
    if (retained) {
      void request.catch(() => undefined);
      return retained.url;
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
    let bytes = [...this.entries.values(), ...this.retired.values()].reduce((n, e) => n + e.bytes, 0);
    const visible = new Set(typeof document === 'undefined' ? [] : Array.from(document.images).map((img) => img.src));
    for (const [url, entry] of this.retired) {
      if (visible.has(url)) continue;
      URL.revokeObjectURL(url);
      this.retired.delete(url);
      bytes -= entry.bytes;
    }
    for (const [key, entry] of this.entries) {
      if (this.entries.size < 200 && bytes + incoming <= 32 * 1024 * 1024) break;
      if (visible.has(entry.url)) continue;
      URL.revokeObjectURL(entry.url);
      this.entries.delete(key);
      bytes -= entry.bytes;
    }
  }
  invalidateSource(source: string) {
    const prefix = JSON.stringify([source]).slice(0, -1) + ',';
    for (const [key, operation] of this.operations)
      if (key.startsWith(prefix)) {
        operation.abort();
        this.operations.delete(key);
        this.pending.delete(key);
      }
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      this.retired.set(entry.url, entry);
    }
    this.failures.clear();
    this.trim(0);
  }
  clear() {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    for (const entry of this.entries.values()) URL.revokeObjectURL(entry.url);
    for (const url of this.retired.keys()) URL.revokeObjectURL(url);
    this.retired.clear();
    this.failures.clear();
    this.entries.clear();
    this.pending.clear();
    this.operations.clear();
  }
}
