import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { registerWebNovelMetadataCollectorGateway } from './webnovel-metadata-collector-gateway.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appWith(fetchImpl: typeof fetch, configured = true, remoteAuth = false) {
  const app = Fastify();
  apps.push(app);
  const config = loadConfig(
    configured
      ? {
          WEBNOVEL_METADATA_COLLECTOR_URL: 'http://metadata-collector:8000',
          WEBNOVEL_METADATA_COLLECTOR_REMOTE_AUTH_ENABLED: String(remoteAuth),
        }
      : {},
  );
  await registerWebNovelMetadataCollectorGateway(app, config, { fetchImpl });
  return app;
}

function healthBody(adultAvailable = true, browserPresentation = 'local_window') {
  return {
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
        ttl_seconds: 300,
        max_bytes: 10 * 1024 * 1024,
        content_types: ['image/jpeg', 'image/png', 'image/webp'],
      },
      adult_auth: {
        version: 1,
        available: adultAvailable,
        browser_presentation: browserPresentation,
        platforms: ['naver_series', 'kakao_page', 'novelpia', 'ridi'],
      },
    },
  };
}

describe('webnovel metadata collector gateway', () => {
  it('is fail-closed and optional when the internal collector is not configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await appWith(fetchImpl, false);

    const response = await app.inject({ method: 'GET', url: '/api/integrations/webnovel-metadata/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ detail: '웹소설 정보 수집기가 이 서버에서 사용 설정되지 않았습니다.' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards health through the internal URL and disables server-side browser login', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(healthBody(), { headers: { 'Content-Type': 'application/json' } }),
    );
    const app = await appWith(fetchImpl);

    const response = await app.inject({ method: 'GET', url: '/api/integrations/webnovel-metadata/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json().capabilities.adult_auth.available).toBe(false);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://metadata-collector:8000/health');
    expect(init?.credentials).toBe('omit');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });

  it('advertises adult auth only for an explicitly enabled remote-frame collector', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(healthBody(true, 'remote_frame'), { headers: { 'Content-Type': 'application/json' } }),
    );
    const app = await appWith(fetchImpl, true, true);

    const response = await app.inject({ method: 'GET', url: '/api/integrations/webnovel-metadata/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json().capabilities.adult_auth).toMatchObject({
      available: true,
      browser_presentation: 'remote_frame',
    });
  });

  it('keeps auth routes unavailable when the optional auth profile is not enabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = await appWith(fetchImpl);

    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/webnovel-metadata/api/v1/auth/status',
    });

    expect(response.statusCode).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards bounded batch JSON without browser cookies or authorization', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ results: [], fetched_at: '2026-08-29T00:00:00Z' }),
    );
    const app = await appWith(fetchImpl);
    const payload = { items: [{ query: '바바리안 퀘스트', include_adult: false }] };

    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/webnovel-metadata/api/v1/resolve/batch',
      headers: { cookie: 'moya_session=private', authorization: 'Bearer private' },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://metadata-collector:8000/api/v1/resolve/batch');
    expect(JSON.parse(String(init?.body))).toEqual(payload);
    expect(new Headers(init?.headers).has('cookie')).toBe(false);
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });

  it('passes a validated cover image without exposing an arbitrary proxy path', async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes.byteLength) } }),
    );
    const app = await appWith(fetchImpl);

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/integrations/webnovel-metadata/api/v1/covers/not.valid',
    });
    const valid = await app.inject({
      method: 'GET',
      url: '/api/integrations/webnovel-metadata/api/v1/covers/valid_cover_ref',
    });

    expect(invalid.statusCode).toBe(400);
    expect(valid.statusCode).toBe(200);
    expect(valid.headers['content-type']).toContain('image/jpeg');
    expect(valid.rawPayload).toEqual(Buffer.from(bytes));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops an upstream body that exceeds the route limit without a content-length header', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(new Uint8Array(65 * 1024), { headers: { 'Content-Type': 'application/json' } }),
    );
    const app = await appWith(fetchImpl);

    const response = await app.inject({ method: 'GET', url: '/api/integrations/webnovel-metadata/health' });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ detail: '웹소설 정보 수집기 응답이 허용 크기를 초과했습니다.' });
  });

  it('forwards only bounded remote-browser frames and actions without browser credentials', async () => {
    const frame = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'POST') return new Response(null, { status: 204 });
      return new Response(frame, {
        headers: {
          'Content-Type': 'image/jpeg',
          'X-Moya-Frame-Revision': '7',
          'X-Moya-Frame-Width': '1280',
          'X-Moya-Frame-Height': '800',
        },
      });
    });
    const app = await appWith(fetchImpl, true, true);

    const frameResponse = await app.inject({
      method: 'GET',
      url: '/api/integrations/webnovel-metadata/api/v1/auth/browser/frame?after_revision=6',
      headers: { cookie: 'moya_session=private', authorization: 'Bearer private' },
    });
    const actionResponse = await app.inject({
      method: 'POST',
      url: '/api/integrations/webnovel-metadata/api/v1/auth/browser/action',
      payload: { action: 'click', x: 120, y: 240 },
    });

    expect(frameResponse.statusCode).toBe(200);
    expect(frameResponse.rawPayload).toEqual(Buffer.from(frame));
    expect(frameResponse.headers['x-moya-frame-revision']).toBe('7');
    expect(frameResponse.headers['x-moya-frame-width']).toBe('1280');
    expect(frameResponse.headers['x-moya-frame-height']).toBe('800');
    expect(actionResponse.statusCode).toBe(204);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).has('cookie')).toBe(false);
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
    }
  });
});
