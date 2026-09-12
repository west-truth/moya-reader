import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function worker(failInstall = false, base = '/', version = 'test', data = new Map<string, Map<string, Response>>()) {
  const origin = 'https://reader.invalid';
  const prefix = `moya-web-shell:${encodeURIComponent(base)}:`;
  const cacheName = prefix + version;
  const handlers = new Map<string, (event: any) => void>();
  const key = (request: string | Request) => new URL(typeof request === 'string' ? request : request.url, origin).href;
  const failures = new Set<string>();
  const cacheApi = {
    keys: async () => [...data.keys()],
    delete: vi.fn(async (name: string) => data.delete(name)),
    open: async (name: string) => {
      if (!data.has(name)) data.set(name, new Map());
      const cache = data.get(name)!;
      return {
        put: async (request: string | Request, response: Response) => cache.set(key(request), response.clone()),
        match: async (request: string | Request) => cache.get(key(request))?.clone(),
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
  const fetch = vi.fn(async (request: Request) => {
    if (failInstall || failures.has(new URL(request.url).pathname)) throw new Error('offline');
    return new Response('network ' + request.url);
  });
  const files = ['index.html', 'assets/reader.js', 'LICENSE', 'assets/pdf.js', 'assets/archive.wasm'].map(
    (file) => base + file,
  );
  const source = readFileSync(new URL('../scripts/service-worker.js', import.meta.url), 'utf8').replace(
    "{ version: '__BUILD_VERSION__', files: [] }",
    JSON.stringify({
      version,
      files,
      precache: files.slice(0, 3),
      assets: files.map((url) => ({ url, bytes: 100, integrity: 'sha256-fixture', verify: !url.endsWith('.html') })),
    }),
  );
  runInNewContext(source, { self, caches: cacheApi, URL, Request: WebRequest, Response, Headers, fetch, Set });
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
  async function message(type: string) {
    const messages: any[] = [];
    await event('message', { data: { type }, ports: [{ postMessage: (value: unknown) => messages.push(value) }] });
    return messages;
  }
  return { event, request, message, data, self, cacheName, prefix, cacheApi, fetch, failures };
}

describe('offline application cache boundary', () => {
  it('installs only the initial screen and downloads optional formats when used', async () => {
    const w = worker();
    await w.event('install');
    expect(w.fetch).toHaveBeenCalledTimes(3);
    expect(w.data.get(w.cacheName)?.size).toBe(3);
    w.fetch.mockClear();
    expect(await (await w.request('/?code=private', { mode: 'navigate' }))?.text()).toContain('/index.html');
    expect(await (await w.request('/assets/reader.js'))?.text()).toContain('/assets/reader.js');
    expect(w.fetch).not.toHaveBeenCalled();
    await w.request('/assets/pdf.js');
    await w.request('/assets/pdf.js');
    expect(w.fetch).toHaveBeenCalledOnce();
    expect(w.data.get(w.cacheName)?.size).toBe(4);
    expect(w.self.skipWaiting).not.toHaveBeenCalled();
  });
  it('prepares unread formats explicitly and reports resumable progress', async () => {
    const w = worker();
    await w.event('install');
    w.failures.add('/assets/archive.wasm');
    const failed = await w.message('PREPARE_OFFLINE');
    expect(failed.at(-1).type).toBe('error');
    expect(w.data.get(w.cacheName)?.size).toBe(4);
    expect(await (await w.request('/', { mode: 'navigate' }))?.text()).toContain('/index.html');
    w.failures.clear();
    w.fetch.mockClear();
    const resumed = await w.message('PREPARE_OFFLINE');
    expect(w.fetch).toHaveBeenCalledOnce();
    expect(resumed.at(-1)).toMatchObject({
      type: 'complete',
      total: 5,
      completed: 5,
      cachedBytes: 500,
      preparing: false,
    });
    expect((await w.message('OFFLINE_STATUS'))[0]).toMatchObject({ completed: 5, totalBytes: 500 });
  });
  it('reuses identical verified assets across versions instead of downloading them again', async () => {
    const previous = worker(false, '/', 'old');
    await previous.event('install');
    await previous.message('PREPARE_OFFLINE');
    const next = worker(false, '/', 'new', previous.data);
    await next.event('install');
    await next.message('PREPARE_OFFLINE');
    expect(next.fetch).toHaveBeenCalledOnce();
    expect(next.fetch.mock.calls[0][0].url).toContain('/index.html');
    expect(next.fetch.mock.calls[0][0].integrity).toBe('');
    expect(next.data.get(next.cacheName)?.size).toBe(6);
    expect((await next.message('OFFLINE_STATUS'))[0].completed).toBe(5);
  });
  it('keeps project navigation, OAuth callbacks and cache cleanup inside its mount path', async () => {
    const w = worker(false, '/moya-reader/');
    const sibling = 'moya-web-shell:%2Fsibling%2F:old';
    w.data.set(sibling, new Map());
    await w.event('install');
    await w.event('activate');
    w.fetch.mockClear();
    expect(w.data.has(sibling)).toBe(true);
    expect(await (await w.request('/moya-reader/?code=private', { mode: 'navigate' }))?.text()).toContain(
      '/moya-reader/index.html',
    );
    expect(await (await w.request('/moya-reader/LICENSE', { mode: 'navigate' }))?.text()).toContain(
      '/moya-reader/LICENSE',
    );
    expect(w.request('/sibling/', { mode: 'navigate' })).toBeUndefined();
    expect(w.request('/assets/reader.js')).toBeUndefined();
    expect(w.fetch).not.toHaveBeenCalled();
    expect([...w.data.get(w.cacheName)!.keys()].some((url) => url.includes('private'))).toBe(false);
  });
  it('never intercepts cloud data, credentials, APIs, ranges or mutations', () => {
    const w = worker();
    expect(w.request('https://content.dropboxapi.com/2/files/download')).toBeUndefined();
    expect(w.request('/api/books')).toBeUndefined();
    expect(w.request('/assets/reader.js', { headers: { Authorization: 'Bearer secret' } })).toBeUndefined();
    expect(w.request('/assets/reader.js', { headers: { Range: 'bytes=0-9' } })).toBeUndefined();
    expect(w.request('/assets/reader.js', { method: 'POST' })).toBeUndefined();
    expect(w.request('/runtime-config.js')).toBeUndefined();
    expect(w.request('/sw.js')).toBeUndefined();
  });
  it('does not cache unknown paths or asset query strings', async () => {
    const w = worker();
    await w.event('install');
    await w.request('/assets/reader.js?private=value');
    await w.request('/assets/user-file.txt');
    expect(
      [...w.data.get(w.cacheName)!.keys()].some((url) => url.includes('private') || url.includes('user-file')),
    ).toBe(false);
  });
  it('rolls back a failed initial install without touching old or unrelated caches', async () => {
    const w = worker(true);
    w.data.set(w.prefix + 'old', new Map());
    w.data.set('other-app', new Map());
    await expect(w.event('install')).rejects.toThrow('offline');
    expect([...w.data.keys()]).toEqual([w.prefix + 'old', 'other-app']);
  });
  it('preserves an older tab and activates updates only on request', async () => {
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
