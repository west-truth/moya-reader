import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { registerTextSourceGateway } from './text-source-gateway.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function create(fetchImpl: typeof fetch, configured = true, timeoutMs = 200) {
  const app = Fastify();
  apps.push(app);
  await registerTextSourceGateway(
    app,
    loadConfig(
      configured
        ? {
            TEXT_SOURCE_SERVER_URL: 'http://text-source:8080',
            TEXT_SOURCE_SERVER_KEY: 'companion-test-key',
          }
        : {},
    ),
    { fetchImpl, timeoutMs },
  );
  return app;
}

describe('text-source gateway', () => {
  it('proxies authenticated artwork as binary images and rejects HTML/SVG cover responses', async () => {
    const image = new Uint8Array([137, 80, 78, 71]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(image, { headers: { 'content-type': 'image/png' } }));
    const app = await create(fetchImpl);
    const path = '/api/integrations/text-sources/v1/sources/source/works/work/cover';
    const response = await app.inject(path);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(Buffer.from(image));
    expect(response.headers['content-type']).toBe('image/png');
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
      Accept: 'image/jpeg, image/png, image/webp',
      Authorization: 'Bearer companion-test-key',
    });
    fetchImpl.mockResolvedValueOnce(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }));
    expect((await app.inject(path)).statusCode).toBe(502);
  });
  it('is optional and only forwards bounded known routes with its own credential', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('preserve  \n\n text', {
        headers: {
          'content-type': 'text/plain;charset=utf-8',
          etag: 'revision',
          'x-moya-source-namespace': '%5B%22server%22%2C%22data%22%2C%22single%22%5D',
        },
      }),
    );
    const off = await create(fetchImpl, false);
    const unavailable = await off.inject('/api/integrations/text-sources/v1/health');
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error).toBe('text_source_server_not_configured');
    const app = await create(fetchImpl);
    const response = await app.inject({
      url: '/api/integrations/text-sources/v1/sources/source/works/work/releases/one/content',
      headers: { authorization: 'Bearer moya-private-key', cookie: 'moya-secret=session' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('preserve  \n\n text');
    expect(response.headers.etag).toBe('revision');
    expect(response.headers['x-moya-source-namespace']).toBe('%5B%22server%22%2C%22data%22%2C%22single%22%5D');
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      'http://text-source:8080/v1/sources/source/works/work/releases/one/content',
      expect.objectContaining({
        redirect: 'error',
        headers: { Accept: 'text/plain', Authorization: 'Bearer companion-test-key' },
      }),
    );
    expect((await app.inject('/api/integrations/text-sources/v1/jobs')).statusCode).toBe(400);
    expect(
      (await app.inject('/api/integrations/text-sources/v1/health?url=https://untrusted.example')).statusCode,
    ).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('cancels an oversized streamed response and does not expose upstream error bodies', async () => {
    const cancelled = vi.fn();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
            },
            cancel: cancelled,
          }),
          { headers: { 'content-type': 'text/plain' } },
        ),
      )
      .mockResolvedValueOnce(new Response('private upstream details', { status: 500 }));
    const app = await create(fetchImpl);
    const bad = await app.inject('/api/integrations/text-sources/v1/sources/s/works/w/releases/r/content');
    expect(bad.statusCode).toBe(502);
    expect(cancelled).toHaveBeenCalled();
    const error = await app.inject('/api/integrations/text-sources/v1/health');
    expect(error.statusCode).toBe(502);
    expect(error.body).not.toContain('private');
  });

  it('keeps cancellation connected while JSON response body is stalled', async () => {
    const cancelled = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new ReadableStream({ cancel: cancelled }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const app = await create(fetchImpl, true, 20);
    expect((await app.inject('/api/integrations/text-sources/v1/health')).statusCode).toBe(502);
    expect(cancelled).toHaveBeenCalled();
  });

  it.each([
    [401, 'authentication_required', 502],
    [403, 'source_access_required', 502],
    [409, 'source_verification_required', 409],
    [502, 'content_provider_authentication_required', 502],
    [503, 'content_provider_busy', 503],
    [413, 'source_size_limit', 413],
  ])('passes only the safe %s/%s code and keeps companion authentication separate', async (status, error, expected) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error, detail: 'https://private-source.invalid/key/secret', key: 'secret' }), {
        status: Number(status),
        headers: { 'content-type': 'application/json', 'x-private-diagnostic': 'secret', etag: 'secret' },
      }),
    );
    const app = await create(fetchImpl);
    const response = await app.inject('/api/integrations/text-sources/v1/sources/s/works/w/releases/r/content');
    expect(response.statusCode).toBe(expected);
    expect(response.json()).toEqual({ error, detail: '텍스트 소스 요청을 완료하지 못했습니다.' });
    expect(response.body).not.toContain('private-source');
    expect(response.body).not.toContain('secret');
    expect(response.headers['x-private-diagnostic']).toBeUndefined();
    expect(response.headers.etag).toBeUndefined();
  });

  it('redacts unknown codes and malformed error JSON instead of passing upstream diagnostics', async () => {
    const values = [
      JSON.stringify({ error: 'source_internal_secret', detail: 'secret' }),
      JSON.stringify({ error: { message: 'secret' } }),
      JSON.stringify(['source_access_required', 'secret']),
      '{"error":"source_access_required","detail":secret}',
    ];
    const fetchImpl = vi.fn<typeof fetch>();
    for (const body of values)
      fetchImpl.mockResolvedValueOnce(
        new Response(body, { status: 403, headers: { 'content-type': 'application/json' } }),
      );
    const app = await create(fetchImpl);
    for (const _value of values) {
      const response = await app.inject('/api/integrations/text-sources/v1/health');
      expect(response.statusCode).toBe(502);
      expect(response.json().error).toBe('source_request_failed');
      expect(response.body).not.toContain('secret');
      expect(response.body).not.toContain('source_access_required');
    }
  });

  it('cancels error bodies above eight KiB with and without a Content-Length header', async () => {
    const cancelled = [vi.fn(), vi.fn()];
    const fetchImpl = vi.fn<typeof fetch>();
    for (const [index, cancel] of cancelled.entries()) {
      fetchImpl.mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(8 * 1024 + 1));
            },
            cancel,
          }),
          {
            status: 403,
            headers: {
              'content-type': 'application/json',
              ...(index ? { 'content-length': String(8 * 1024 + 1) } : {}),
            },
          },
        ),
      );
    }
    const app = await create(fetchImpl);
    for (const cancel of cancelled) {
      const response = await app.inject('/api/integrations/text-sources/v1/health');
      expect(response.statusCode).toBe(502);
      expect(cancel).toHaveBeenCalled();
      expect(['source_request_failed', 'source_invalid_response']).toContain(response.json().error);
    }
  });

  it('cancels a stalled error stream and reports a local timeout code', async () => {
    const cancelled = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new ReadableStream({ cancel: cancelled }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const app = await create(fetchImpl, true, 20);
    const response = await app.inject('/api/integrations/text-sources/v1/health');
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('source_timeout');
    expect(cancelled).toHaveBeenCalled();
  });
});
