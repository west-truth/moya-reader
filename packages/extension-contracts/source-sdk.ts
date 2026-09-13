import type { ExternalSourceBrowseState, ExternalSourceBrowseMode, ExternalSourceFilterChange } from './source-browse';
/** Bundled into guest JS. No Node, browser, platform or application imports. */
export interface SourceWebViewRequest {
  readonly url: string;
  /** JavaScript expression evaluated after DOMContentLoaded. May return a Promise. */
  readonly script: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly waitUntil?: 'load' | 'domcontentloaded';
}
export interface SourceAsset {
  readonly handle: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly contentType: string;
}

export interface SourceWork {
  readonly id: string;
  readonly title: string;
  readonly author?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly hasCover?: boolean;
  readonly revision?: string;
}

export interface SourceRelease {
  readonly id: string;
  readonly title: string;
  /** Stable numeric order, independent of the website's listing direction. */
  readonly order: number;
  readonly number?: number;
  readonly revision?: string;
}

export interface SourcePage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly browse?: ExternalSourceBrowseState;
}

export type SourceContent =
  | { readonly kind: 'text'; readonly asset: SourceAsset }
  | { readonly kind: 'images'; readonly assets: readonly SourceAsset[] };

/** Returned only to the host. The guest has already checked work/release membership before constructing this request. */
export interface SourceContentRequest {
  readonly kind: 'service';
  readonly service: 'text-content';
  readonly version: 1;
  readonly url: string;
}
/** Finish guest execution before the host performs a possibly long content job. No endpoint or credential here. */
export function providerText(url: string): SourceContentRequest {
  return { kind: 'service', service: 'text-content', version: 1, url };
}

export interface SourceHttpInput {
  /** Ask the host to use this source's verified connection. Never supply tokens in headers or URLs. */
  readonly authenticated?: boolean;
  readonly url: string;
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Partial<Record<'accept' | 'content-type' | 'accept-language', string>>>;
  readonly body?: string;
}

export type SourceJsonValue =
  null | boolean | number | string | readonly SourceJsonValue[] | { readonly [key: string]: SourceJsonValue };

export interface SourceContext {
  sleep(milliseconds: number): Promise<void>;
  readonly preferences: { get(key: string): Promise<string | number | boolean | null> };
  /** Requires requestedAccess.webview. The host applies the package's network grants to every browser request. */
  readonly webview: {
    evaluate(input: SourceWebViewRequest): Promise<SourceJsonValue>;
  };
  /** Non-secret source data; writes commit together only after a successful, still-current invocation. */
  readonly storage: {
    get(key: string): Promise<SourceJsonValue>;
    set(key: string, value: SourceJsonValue): Promise<void>;
    remove(key: string): Promise<void>;
  };
  readonly http: {
    /** Full HTTP response for source-defined service protocols. No implicit authentication server. */
    request(input: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }>;
    text(input: SourceHttpInput): Promise<string>;
    asset(input: SourceHttpInput): Promise<SourceAsset>;
  };
  /** Use only for parsed text; downloading an existing TXT as an asset preserves its original bytes. */
  textAsset(text: string): Promise<SourceAsset>;
}

export interface SourceDefinition {
  readonly id: string;
  listWorks(
    input: {
      query?: string;
      cursor?: string;
      browseMode?: ExternalSourceBrowseMode;
      filters?: readonly ExternalSourceFilterChange[];
    },
    context: SourceContext,
  ): Promise<SourcePage<SourceWork>>;
  getWork(input: { workId: string }, context: SourceContext): Promise<SourceWork>;
  listReleases(input: { workId: string; cursor?: string }, context: SourceContext): Promise<SourcePage<SourceRelease>>;
  getContent(
    input: { workId: string; releaseId: string },
    context: SourceContext,
  ): Promise<SourceContent | SourceContentRequest>;
  getCover?(input: { workId: string }, context: SourceContext): Promise<SourceAsset | null>;
}

export function defineSource<T extends SourceDefinition>(source: T): T {
  return source;
}

interface GuestHost {
  request(method: string, input: unknown): Promise<unknown>;
}

/** Default export consumed by the build tool. Each invocation starts with a fresh realm. */
export function defineExtension(input: { sources: readonly SourceDefinition[] }) {
  for (const source of input.sources) {
    if (
      ['listWorks', 'getWork', 'listReleases', 'getContent'].some(
        (name) => typeof source[name as keyof SourceDefinition] !== 'function',
      )
    )
      throw new Error('invalid_source_definition');
  }
  const sources = new Map(input.sources.map((source) => [source.id, source]));
  if (sources.size !== input.sources.length) throw new Error('duplicate_source');
  return async (method: string, payload: Record<string, unknown>, host: GuestHost): Promise<unknown> => {
    if (method === 'describe')
      return { apiVersion: 1, sources: [...sources.values()].map(({ id, getCover }) => ({ id, cover: !!getCover })) };
    const source = sources.get(payload.sourceId as string);
    if (!source) throw new Error('unknown_source');
    const context: SourceContext = {
      sleep: async (milliseconds) => {
        await host.request('source.sleep', { milliseconds });
      },
      preferences: {
        get: async (key) => (await host.request('preferences.get', { key })) as string | number | boolean | null,
      },
      webview: { evaluate: async (request) => (await host.request('webview.evaluate', request)) as SourceJsonValue },
      storage: {
        get: async (key) => (await host.request('storage.get', { key })) as SourceJsonValue,
        set: async (key, value) => {
          await host.request('storage.set', { key, value });
        },
        remove: async (key) => {
          await host.request('storage.remove', { key });
        },
      },
      http: {
        request: async (request) =>
          (await host.request('source.request', request)) as {
            statusCode: number;
            headers: Record<string, unknown>;
            body: string;
          },
        text: async (request) => {
          const response = (await host.request('http.request', { ...request, response: 'text' })) as { text: string };
          return response.text;
        },
        asset: async (request) =>
          (await host.request('http.request', { ...request, response: 'asset' })) as SourceAsset,
      },
      textAsset: async (text) => (await host.request('asset.fromText', { text })) as SourceAsset,
    };
    switch (method) {
      case 'source.listWorks':
        return source.listWorks(payload as { query?: string; cursor?: string }, context);
      case 'source.getWork':
        return source.getWork(payload as unknown as { workId: string }, context);
      case 'source.listReleases':
        return source.listReleases(payload as unknown as { workId: string; cursor?: string }, context);
      case 'source.getContent':
        return source.getContent(payload as unknown as { workId: string; releaseId: string }, context);
      case 'source.getCover':
        return source.getCover ? source.getCover(payload as unknown as { workId: string }, context) : null;
      default:
        throw new Error('unknown_method');
    }
  };
}
