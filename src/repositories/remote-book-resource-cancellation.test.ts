import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteApiClient } from '../services/remote/remote-api-client';
import { RemoteBookAssetRepository } from './remote-book-asset-repository';

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe('remote image resource cancellation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
