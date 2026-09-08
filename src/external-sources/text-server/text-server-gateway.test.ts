import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteApiClient } from '../../services/remote/remote-api-client';

afterEach(() => vi.unstubAllGlobals());

describe('text-source managed gateway transport', () => {
  it('allows a work cover through the same-origin gateway with the Moya token', async () => {
    const image = new Uint8Array([137, 80, 78, 71]);
    const fetchImpl = vi.fn(async () => new Response(image, { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchImpl);
    const client = new RemoteApiClient('/api', { getAuthToken: () => 'moya-session-token' });
    const response = await client.fetchTextSourceGateway(
      '/v1/sources/source/works/work/cover',
      new AbortController().signal,
    );

    expect(await response.arrayBuffer()).toEqual(image.buffer);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/integrations/text-sources/v1/sources/source/works/work/cover',
      expect.objectContaining({
        headers: { Authorization: 'Bearer moya-session-token' },
        credentials: 'same-origin',
        redirect: 'error',
      }),
    );
  });

  it('uses the Moya token and retains the caller signal after headers for bounded body consumption', async () => {
    let requestSignal: AbortSignal | undefined;
    const aborted = vi.fn();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      requestSignal.addEventListener('abort', aborted);
      return new Response('text', { headers: { 'Content-Type': 'text/plain' } });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const client = new RemoteApiClient('/api', { getAuthToken: () => 'moya-session-token' });
    const caller = new AbortController();
    await client.fetchTextSourceGateway('/v1/sources/source/works/work/releases/one/content', caller.signal);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/integrations/text-sources/v1/sources/source/works/work/releases/one/content',
      expect.objectContaining({
        headers: { Authorization: 'Bearer moya-session-token' },
        credentials: 'same-origin',
        redirect: 'error',
      }),
    );
    expect(requestSignal).toBe(caller.signal);
    caller.abort();
    expect(aborted).toHaveBeenCalledOnce();
  });

  it('rejects arbitrary gateway paths before fetching', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const client = new RemoteApiClient('/api');
    for (const path of [
      'https://untrusted.test',
      '/v1/../admin',
      '/v1/sources/a/works/b/releases/c/delete',
      '/v1/sources/a/works/b/cover/extra',
      '/v1/sources/a/works/b/%63over',
      '/v1/sources/a%2fb',
    ]) {
      await expect(client.fetchTextSourceGateway(path, new AbortController().signal)).rejects.toThrow('지원하지 않는');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
