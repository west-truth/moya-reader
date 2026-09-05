import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteApiClient } from '../services/remote/remote-api-client';
import { RemoteBookAssetRepository } from './remote-book-asset-repository';
import { ArchivePageLoader, type ArchivePageSnapshot } from '../features/fixed-document/archive-page-loader';

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe('remote image resource cancellation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([200, 401, 503])(
    'keeps cancellation connected during a delayed JSON/error body (HTTP %s)',
    async (status) => {
      vi.useFakeTimers();
      let networkSignal!: AbortSignal;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          networkSignal = init.signal!;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(body) {
                body.enqueue(new TextEncoder().encode('{'));
                networkSignal.addEventListener('abort', () => body.error(networkSignal.reason), { once: true });
              },
            }),
            { status, headers: { 'content-type': 'application/json' } },
          );
        }),
      );
      const onUnauthorized = vi.fn();
      const client = new RemoteApiClient('/api', { requestTimeoutMs: 10, onUnauthorized });
      const caller = new AbortController();
      const result = client.listPages('chapter', 0, 1, undefined, caller.signal).catch((error: unknown) => error);
      await settle();
      await vi.advanceTimersByTimeAsync(100);
      expect(networkSignal.aborted).toBe(false); // Header timeout must not become a body deadline.
      caller.abort();
      expect(networkSignal.aborted).toBe(true);
      expect(await result).toMatchObject({ name: 'AbortError' });
      expect(onUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    },
  );

  it.each([
    { status: 200, body: '{"ok":true}', outcome: 'success' },
    { status: 200, body: '{', outcome: 'SyntaxError' },
    { status: 503, body: '{"error":"unavailable"}', outcome: 'remote-error' },
    { status: 204, body: null, outcome: 'empty' },
  ])('detaches cancellation after JSON completion: $outcome', async ({ status, body, outcome }) => {
    let networkSignal!: AbortSignal;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        networkSignal = init.signal!;
        return new Response(body, { status });
      }),
    );
    const caller = new AbortController();
    const request = new RemoteApiClient('/api').request('/metadata', { signal: caller.signal });
    if (outcome === 'success') await expect(request).resolves.toEqual({ ok: true });
    else if (outcome === 'empty') await expect(request).resolves.toBeUndefined();
    else if (outcome === 'SyntaxError') await expect(request).rejects.toBeInstanceOf(SyntaxError);
    else await expect(request).rejects.toMatchObject({ status: 503, message: 'unavailable' });
    caller.abort();
    expect(networkSignal.aborted).toBe(false);
  });

  it('releases all three delayed metadata slots so the latest comic page can load', async () => {
    const requests: Array<{ index: number; signal: AbortSignal }> = [];
    const delayedBodies: ReadableStreamDefaultController<Uint8Array>[] = [];
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:latest');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const index = Number(/\/chapters\/(\d+)\//.exec(url)?.[1]);
        const signal = init.signal!;
        requests.push({ index, signal });
        if (index >= 50) return Response.json({ pages: [] });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(body) {
              delayedBodies.push(body);
              body.enqueue(new TextEncoder().encode('{'));
              signal.addEventListener('abort', () => body.error(signal.reason), { once: true });
            },
          }),
        );
      }),
    );
    const client = new RemoteApiClient('/api');
    let snapshot: ArchivePageSnapshot = { pages: new Map(), errors: new Map() };
    const loader = new ArchivePageLoader(
      async (index, signal) => {
        await client.listPages(String(index), 0, 1, undefined, signal);
        signal.throwIfAborted();
        return { blob: new Blob([String(index)]) };
      },
      (next) => {
        snapshot = next;
      },
    );
    try {
      loader.update(2, [0, 1, 2]);
      await settle();
      expect(requests.map(({ index }) => index)).toEqual([2, 0, 1]);
      loader.update(50, [50, 51, 52]);
      expect(requests.slice(0, 3).every(({ signal }) => signal.aborted)).toBe(true);
      await vi.waitFor(() => expect(snapshot.pages.has(50)).toBe(true));
      expect(requests.slice(3).map(({ index }) => index)).toEqual([50, 51, 52]);
      expect(snapshot.errors.size).toBe(0);
      expect(snapshot.pages.has(2)).toBe(false);
    } finally {
      loader.dispose();
      for (const body of delayedBodies) {
        try {
          body.close();
        } catch {
          /* Already aborted. */
        }
      }
    }
  });

  it('cancels the actual network body after headers have already arrived', async () => {
    let networkSignal!: AbortSignal;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        networkSignal = init.signal!;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              networkSignal.addEventListener('abort', () => controller.error(networkSignal.reason));
            },
          }),
          { headers: { 'content-type': 'image/png' } },
        );
      }),
    );
    const repository = new RemoteBookAssetRepository(new RemoteApiClient('/api'));
    const controller = new AbortController();
    const request = repository.getEmbeddedResource('book', 'page', controller.signal);
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await settle();
    expect(networkSignal.aborted).toBe(false);
    controller.abort();
    await rejected;
    expect(networkSignal.aborted).toBe(true);
  });

  it('keeps the existing header timeout policy for a long body and detaches cancellation after completion', async () => {
    vi.useFakeTimers();
    let networkSignal!: AbortSignal;
    let body!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        networkSignal = init.signal!;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            },
          }),
        );
      }),
    );
    const client = new RemoteApiClient('/api', { requestTimeoutMs: 10 });
    const controller = new AbortController();
    const request = client.getBookResource('book', 'page', controller.signal);
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(networkSignal.aborted).toBe(false);
    body.enqueue(new Uint8Array([1, 2, 3]));
    body.close();
    expect((await request).blob.size).toBe(3);
    controller.abort();
    expect(networkSignal.aborted).toBe(false);
  });
});
