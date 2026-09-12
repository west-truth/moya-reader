import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function worker(failInstall = false, base = '/') {
  const origin = 'https://reader.invalid';
  const prefix = `moya-web-shell:${encodeURIComponent(base)}:`;
  const cacheName = prefix + 'test';
  const data = new Map<string, Map<string, Response>>();
  const handlers = new Map<string, (event: any) => void>();
  const key = (request: string | Request) => new URL(typeof request === 'string' ? request : request.url, origin).href;
  const cacheApi = {
    keys: async () => [...data.keys()],
    delete: vi.fn(async (name: string) => data.delete(name)),
    open: async (name: string) => {
      if (!data.has(name)) data.set(name, new Map());
      const cache = data.get(name)!;
      return {
        addAll: async (requests: Request[]) => {
          if (failInstall) throw new Error('quota');
          for (const request of requests) cache.set(key(request), new Response('cached ' + request.url));
        },
        match: async (request: string | Request) => cache.get(key(request)),
      };
    },
  };
  const self = {
    location: { origin },
    registration: { scope: origin + base },
    clients: { claim: vi.fn(async () => {}) },
    skipWaiting: vi.fn(async () => {}),
    addEventListener: (type: string, handler: (event: any) => void) => handlers.set(type, handler),
  };
  class WebRequest extends Request {
    constructor(input: string | Request, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, origin) : input, init);
    }
  }
  const fetch = vi.fn(async () => new Response('network'));
  const source = readFileSync(new URL('../scripts/service-worker.js', import.meta.url), 'utf8').replace(
    "{ version: '__BUILD_VERSION__', files: [] }",
    JSON.stringify({
      version: 'test',
      files: ['index.html', 'assets/reader.js', 'LICENSE'].map((file) => base + file),
    }),
  );
  runInNewContext(source, { self, caches: cacheApi, URL, Request: WebRequest, fetch, Set });
  async function event(type: string, extra: Record<string, unknown> = {}) {
    let result: Promise<unknown> | undefined;
    handlers.get(type)!({
      ...extra,
      waitUntil: (value: Promise<unknown>) => {
        result = value;
      },
    });
    return result;
  }
  function request(url: string, options: { mode?: string; headers?: Record<string, string>; method?: string } = {}) {
    let response: Promise<Response> | undefined;
    handlers.get('fetch')!({
      request: {
        url: new URL(url, origin).href,
        method: options.method ?? 'GET',
        mode: options.mode ?? 'cors',
        headers: new Headers(options.headers),
      },
      respondWith: (value: Promise<Response>) => {
        response = value;
      },
    });
    return response;
  }
  return { event, request, data, self, cacheName, prefix, cacheApi, fetch };
}

describe('offline application cache boundary', () => {
  it('keeps project Pages navigation, OAuth callbacks and caches inside its mount path', async () => {
    const w = worker(false, '/moya-reader/');
    const sibling = 'moya-web-shell:%2Fsibling%2F:old';
    w.data.set(sibling, new Map());
    w.data.set('moya-web-shell:%2F:old', new Map());
    await w.event('install');
    await w.event('activate');
    expect(w.data.has(sibling)).toBe(true);
    expect(w.data.has('moya-web-shell:%2F:old')).toBe(true);
    expect(await (await w.request('/moya-reader/?code=private', { mode: 'navigate' }))?.text()).toContain(
      '/moya-reader/index.html',
    );
    expect(await (await w.request('/moya-reader/assets/reader.js'))?.text()).toContain('/moya-reader/assets/reader.js');
    expect(await (await w.request('/moya-reader/LICENSE', { mode: 'navigate' }))?.text()).toContain(
      '/moya-reader/LICENSE',
    );
    expect(w.request('/sibling/', { mode: 'navigate' })).toBeUndefined();
    expect(w.request('/assets/reader.js')).toBeUndefined();
    expect(w.request('/moya-reader/api/books')).toBeUndefined();
    expect(w.request('/moya-reader/sw.js')).toBeUndefined();
    expect(w.fetch).not.toHaveBeenCalled();
  });
  it('serves installed HTML and unread lazy chunks without a network connection', async () => {
    const w = worker();
    await w.event('install');
    expect(await (await w.request('/?code=oauth-sensitive-value', { mode: 'navigate' }))?.text()).toContain(
      '/index.html',
    );
    expect(await (await w.request('/assets/reader.js'))?.text()).toContain('/assets/reader.js');
    expect(w.fetch).not.toHaveBeenCalled();
    expect([...w.data.get(w.cacheName)!.keys()]).not.toContain('https://reader.invalid/?code=oauth-sensitive-value');
    expect(w.self.skipWaiting).not.toHaveBeenCalled();
    expect(await (await w.request('/LICENSE', { mode: 'navigate' }))?.text()).toContain('/LICENSE');
  });
  it('never intercepts cloud data, credentials, APIs, ranges or mutations', () => {
    const w = worker();
    expect(w.request('https://content.dropboxapi.com/2/files/download')).toBeUndefined();
    expect(w.request('/api/books')).toBeUndefined();
    expect(w.request('/assets/reader.js', { headers: { Authorization: 'Bearer secret' } })).toBeUndefined();
    expect(w.request('/assets/reader.js', { headers: { Range: 'bytes=0-9' } })).toBeUndefined();
    expect(w.request('/assets/reader.js', { method: 'POST' })).toBeUndefined();
    expect(w.request('/runtime-config.js')).toBeUndefined();
  });
  it('rolls back failed installation without touching old app or unrelated caches', async () => {
    const w = worker(true);
    w.data.set(w.prefix + 'old', new Map());
    w.data.set('other-app', new Map());
    await expect(w.event('install')).rejects.toThrow('quota');
    expect([...w.data.keys()]).toEqual([w.prefix + 'old', 'other-app']);
  });
  it('preserves another tab and unrelated storage, and activates only on request', async () => {
    const w = worker();
    w.data.set(w.prefix + 'ancient', new Map());
    w.data.set('other-app', new Map());
    w.data.set(w.prefix + 'old', new Map([['https://reader.invalid/assets/old.js', new Response('old chunk')]]));
    await w.event('install');
    await w.event('activate');
    expect(w.data.has('other-app')).toBe(true);
    expect(w.data.has(w.prefix + 'ancient')).toBe(false);
    expect(await (await w.request('/assets/old.js'))?.text()).toBe('old chunk');
    await w.event('message', { data: { type: 'ACTIVATE_UPDATE' } });
    expect(w.self.skipWaiting).toHaveBeenCalledOnce();
  });
});
