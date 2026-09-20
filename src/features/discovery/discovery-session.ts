import {
  sourceCachePolicy,
  sourcePageTime,
  sourceListIdentity,
  transientSourceFailure,
} from '../../external-sources/cache-policy';
import { ExternalSourceLocalStateStore } from '../../external-sources/local-state';
import { storedSourcePage, restoredSourcePage } from '../../external-sources/cached-page';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';
import type {
  ExternalItemKey,
  ExternalItemPage,
  ExternalSourceListInput,
  TrustedExternalSourceHostContext,
} from '../../external-sources/contracts';

/** One session, shared by the home and its source sections. Bounded memory and IndexedDB results; no polling. */
export class DiscoverySession {
  readonly railPositions = new Map<string, number>();
  readonly scrollPositions = new Map<string, { id?: string; offset: number; top: number }>();
  private cache = new Map<string, { page: ExternalItemPage; time: number; bytes: number }>();
  private sourceTails = new Map<string, Promise<void>>();
  private pending = new Map<string, Promise<ExternalItemPage>>();
  private running = 0;
  private queue: Array<() => void> = [];
  private readonly storage = new ExternalSourceLocalStateStore();
  private lifetime = new AbortController();
  constructor(
    readonly registry: ExternalSourceRegistryPort,
    readonly context: TrustedExternalSourceHostContext,
    readonly scope = 'local',
  ) {}
  key(source: string, input: ExternalSourceListInput) {
    const status = this.registry.getExternalSourceStatus(source as ExtensionContributionId, this.context);
    return JSON.stringify([
      this.scope,
      source,
      status.state,
      status.accountConnectionId,
      status.connectionGeneration,
      sourceListIdentity(input),
    ]);
  }
  peek(source: string, input: ExternalSourceListInput) {
    const key = this.key(source, input);
    const cached = this.cache.get(key);
    if (cached && cached.time + sourceCachePolicy(input).keep <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
    }
    return cached;
  }
  async schema(source: string, input: ExternalSourceListInput, refresh = false) {
    const key = `schema:${this.key(source, input)}`;
    let saved = this.cache.get(key);
    if (!saved && typeof indexedDB !== 'undefined') {
      const disk = await this.storage.getCachePage(key).catch(() => undefined);
      if (disk && !this.lifetime.signal.aborted) {
        this.remember(key, restoredSourcePage(disk));
        saved = this.cache.get(key);
      }
    }
    this.lifetime.signal.throwIfAborted();
    if (key !== `schema:${this.key(source, input)}`) throw new Error('package_generation_changed');
    if (saved && saved.time + 7 * 86400_000 <= Date.now()) {
      this.cache.delete(key);
      saved = undefined;
    }
    if (!refresh && saved && saved.time + 6 * 3600_000 > Date.now()) return saved.page;
    try {
      const page = await this.list(source, input, refresh);
      if (key !== `schema:${this.key(source, input)}`) throw new Error('package_generation_changed');
      const schema = { items: [], browse: page.browse, cache: page.cache };
      this.remember(key, schema);
      if (typeof indexedDB !== 'undefined') {
        const time = sourcePageTime(schema);
        void this.storage
          .saveCachePage({
            ...storedSourcePage(key, source, input, schema, this.scope),
            expiresAt: new Date(time + 6 * 3600_000).toISOString(),
            retainUntil: new Date(time + 7 * 86400_000).toISOString(),
          })
          .catch(() => undefined);
      }
      return schema;
    } catch (error) {
      if (!refresh && saved && transientSourceFailure(error)) return saved.page;
      throw error;
    }
  }
  async restore(source: string, input: ExternalSourceListInput) {
    const key = this.key(source, input);
    if (this.peek(source, input)) return this.peek(source, input)?.page;
    if (typeof indexedDB === 'undefined') return undefined;
    const saved = await this.storage.getCachePage(key).catch(() => undefined);
    if (!saved || this.lifetime.signal.aborted || key !== this.key(source, input)) return undefined;
    const page = restoredSourcePage(saved);
    this.remember(key, page);
    return page;
  }
  private remember(key: string, page: ExternalItemPage) {
    this.cache.delete(key);
    this.cache.set(key, {
      page,
      time: sourcePageTime(page),
      bytes: new TextEncoder().encode(JSON.stringify(page)).length,
    });
    let bytes = [...this.cache.values()].reduce((n, v) => n + v.bytes, 0);
    while (this.cache.size > 1000 || bytes > 8 * 1024 * 1024) {
      const oldest = this.cache.keys().next().value!;
      bytes -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
  }
  async list(source: string, input: ExternalSourceListInput, refresh = false): Promise<ExternalItemPage> {
    const key = this.key(source, input);
    const cached = this.peek(source, input);
    const ttl = sourceCachePolicy(input).fresh;
    if (!refresh && cached && !cached.page.cache?.stale && Date.now() - cached.time < ttl) return cached.page;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.serial(source, async () => {
      this.lifetime.signal.throwIfAborted();
      const status = this.registry.getExternalSourceStatus(source as ExtensionContributionId, this.context);
      if (status.state !== 'connected') throw new Error('소스 연결을 확인해 주세요.');
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]);
      const received = await this.registry.listExternalSource(
        source as ExtensionContributionId,
        this.context,
        {
          ...input,
          accountConnectionId: status.accountConnectionId,
          ...(refresh ? { cacheMode: 'reload' as const } : {}),
        },
        signal,
      );
      signal.throwIfAborted();
      if (key !== this.key(source, input)) throw new Error('소스 연결이 변경되었습니다. 다시 열어 주세요.');
      const page = { ...received, cache: { ...received.cache, fetchedAt: sourcePageTime(received) } };
      this.remember(key, page);
      if (typeof indexedDB !== 'undefined')
        void this.storage.saveCachePage(storedSourcePage(key, source, input, page, this.scope)).catch(() => undefined);
      return page;
    });
    this.pending.set(key, request);
    try {
      return await request;
    } finally {
      this.pending.delete(key);
    }
  }
  private async serial<T>(source: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sourceTails.get(source);
    let unlock!: () => void;
    const tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    this.sourceTails.set(source, tail);
    try {
      if (previous) await previous;
      return await this.run(task);
    } finally {
      unlock();
      if (this.sourceTails.get(source) === tail) this.sourceTails.delete(source);
    }
  }
  private async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= 2) await new Promise<void>((resolve) => this.queue.push(resolve));
    else this.running++;
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running--;
    }
  }
  private coverRunning = 0;
  private coverQueue: Array<() => void> = [];
  async cover(key: ExternalItemKey, signal: AbortSignal) {
    if (this.coverRunning >= 4) await new Promise<void>((resolve) => this.coverQueue.push(resolve));
    else this.coverRunning++;
    try {
      signal.throwIfAborted();
      return await this.registry.resolveExternalSourceCover?.(
        key.connectorId as ExtensionContributionId,
        this.context,
        key,
        AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(30_000)]),
      );
    } finally {
      const next = this.coverQueue.shift();
      if (next) next();
      else this.coverRunning--;
    }
  }
  private cleanup?: ReturnType<typeof setTimeout>;
  mount() {
    clearTimeout(this.cleanup);
    return () => {
      this.cleanup = setTimeout(() => this.dispose(), 0);
    };
  }
  dispose() {
    this.lifetime.abort();
    this.cache.clear();
    this.railPositions.clear();
    this.scrollPositions.clear();
  }
}
