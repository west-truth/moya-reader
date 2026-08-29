import { describe, expect, it, vi } from 'vitest';
import { NativeWebNovelMetadataCollectorClient } from './native-webnovel-metadata-collector';

function healthResponse(): Response {
  return new Response(
    JSON.stringify({
      status: 'ok',
      service: 'webnovel-metadata-collector',
      version: '0.1.0',
      api_version: 1,
      capabilities: {
        resolve: { version: 1 },
        batch_resolve: { version: 1, max_items: 50 },
        cover_ref: {
          version: 1,
          path: '/api/v1/covers/{cover_ref}',
          ttl_seconds: 900,
          max_bytes: 10 * 1024 * 1024,
          content_types: ['image/jpeg', 'image/png', 'image/webp'],
        },
        adult_auth: { version: 1, available: false, platforms: [] },
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

describe('NativeWebNovelMetadataCollectorClient', () => {
  it('starts one managed sidecar and authenticates every request with an ephemeral token', async () => {
    const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => void>();
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      invokeMock(command, args);
      return (command === 'desktop_metadata_collector_start' ? { endpoint: 'http://127.0.0.1:43123' } : undefined) as T;
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => healthResponse());
    const cryptoImpl = {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        if (array instanceof Uint8Array) array.forEach((_, index) => (array[index] = index));
        return array;
      },
    } as Pick<Crypto, 'getRandomValues'>;
    const client = new NativeWebNovelMetadataCollectorClient(invoke, fetchMock as typeof fetch, cryptoImpl);

    await client.health();
    await client.health();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const startArgs = invokeMock.mock.calls[0]?.[1] as { sessionToken: string };
    expect(startArgs.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:43123/health');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('X-Moya-Collector-Token')).toBe(
      startArgs.sessionToken,
    );

    await client.stop();
    expect(invokeMock).toHaveBeenLastCalledWith('desktop_metadata_collector_stop', undefined);
  });
});
