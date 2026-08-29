import { describe, expect, it, vi } from 'vitest';
import {
  WebNovelMetadataCollectorClient,
  WebNovelMetadataCollectorError,
  normalizeWebNovelMetadataCollectorEndpoint,
} from './webnovel-metadata-collector-client';

const fetchedAt = '2026-08-27T10:00:00Z';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function healthResponse(): Response {
  return jsonResponse({
    status: 'ok',
    service: 'webnovel-metadata-collector',
    version: '0.1.0',
    api_version: 1,
    capabilities: {
      resolve: { version: 1 },
      batch_resolve: { version: 1, max_items: 50 },
      diagnostic_search: { version: 1 },
      cover_ref: {
        version: 1,
        path: '/api/v1/covers/{cover_ref}',
        ttl_seconds: 900,
        max_bytes: 10 * 1024 * 1024,
        content_types: ['image/jpeg', 'image/png', 'image/webp'],
      },
      adult_auth: {
        version: 1,
        available: true,
        browser_presentation: 'remote_frame',
        platforms: ['naver_series', 'kakao_page', 'novelpia', 'ridi'],
      },
    },
  });
}

function resolveBody(
  overrides: Readonly<Record<string, unknown>> = {},
  metadataOverrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    query: '테스트 작품',
    author: '작가',
    status: 'found',
    confidence: 1,
    match_type: 'exact_title_and_author',
    metadata_quality: 'full',
    metadata: {
      title: '테스트 작품',
      author: '작가',
      platform: 'ridi',
      platform_work_id: 'work-42',
      source_url: 'https://ridibooks.com/books/123/42',
      cover_url: 'https://img.ridicdn.net/cover.jpg',
      description: '소개',
      genres: ['판타지'],
      tags: ['성장'],
      status: 'completed',
      match_score: 1,
      fetched_at: fetchedAt,
      ...metadataOverrides,
    },
    searched_platforms: 5,
    failed_platforms: [],
    platform_errors: {},
    skipped_platforms: [],
    authenticated_search: false,
    cover_ref: 'cover_ref_12345678',
    fetched_at: fetchedAt,
    ...overrides,
  };
}

describe('WebNovelMetadataCollectorClient', () => {
  it('allows loopback HTTP or credential-free HTTPS endpoints only', () => {
    expect(normalizeWebNovelMetadataCollectorEndpoint(' http://localhost:8000/ ')).toBe('http://localhost:8000');
    expect(normalizeWebNovelMetadataCollectorEndpoint('https://collector.example/moya/')).toBe(
      'https://collector.example/moya',
    );
    expect(() => normalizeWebNovelMetadataCollectorEndpoint('http://collector.example')).toThrow(
      WebNovelMetadataCollectorError,
    );
    expect(() => normalizeWebNovelMetadataCollectorEndpoint('https://user:secret@collector.example')).toThrow(
      WebNovelMetadataCollectorError,
    );
  });

  it('validates the versioned health capability contract', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => healthResponse());
    const client = new WebNovelMetadataCollectorClient('http://127.0.0.1:8000', fetchMock as typeof fetch);

    await expect(client.health()).resolves.toMatchObject({
      status: 'ok',
      apiVersion: 1,
      capabilities: {
        batchResolve: { maxItems: 50 },
        coverRef: { ttlSeconds: 900 },
        adultAuth: { available: true, browserPresentation: 'remote_frame' },
      },
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://127.0.0.1:8000/health');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'omit' });
  });

  it('allows the host-owned same-origin gateway to use its session cookie over private HTTP', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => healthResponse());
    const client = new WebNovelMetadataCollectorClient(
      'http://moya.internal/api/integrations/webnovel-metadata',
      fetchMock as typeof fetch,
      { credentials: 'same-origin', allowHttp: true },
    );

    await client.health();

    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin' });
  });

  it('returns structured exact-match automation evidence and blocks unconfirmed adult lookup', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(resolveBody()));
    const client = new WebNovelMetadataCollectorClient('http://127.0.0.1:8000', fetchMock as typeof fetch);

    const publicResult = await client.resolve({ query: ' 테스트 작품 ', author: ' 작가 ' });
    expect(publicResult).toMatchObject({
      status: 'found',
      matchType: 'exact_title_and_author',
      metadataQuality: 'full',
      autoApplyEligible: true,
      autoApplyReasons: [],
      coverRef: 'cover_ref_12345678',
    });

    const adultResult = await client.resolve({ query: '테스트 작품', author: '작가', includeAdult: true });
    expect(adultResult.autoApplyEligible).toBe(false);
    expect(adultResult.autoApplyReasons).toContain('adult_auth_unconfirmed');
    expect(String(fetchMock.mock.calls[1]![0])).toContain('include_adult=true');
  });

  it('posts bounded batch inputs in order and validates each automation decision against its request', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        results: [
          resolveBody(),
          resolveBody(
            { query: '두번째 작품', author: null, match_type: 'exact_title' },
            { title: '두번째 작품', author: null, platform_work_id: 'work-43' },
          ),
        ],
        fetched_at: fetchedAt,
      }),
    );
    const client = new WebNovelMetadataCollectorClient('http://127.0.0.1:8000', fetchMock as typeof fetch);

    const result = await client.resolveBatch([
      { query: '테스트 작품', author: '작가' },
      { query: '두번째 작품', includeAdult: true },
    ]);

    expect(result.results[0]!.autoApplyEligible).toBe(true);
    expect(result.results[1]!.autoApplyReasons).toEqual(['adult_auth_unconfirmed']);
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      items: [
        { query: '테스트 작품', author: '작가', include_adult: false },
        { query: '두번째 작품', include_adult: true },
      ],
    });
  });

  it('accepts only bounded cover bytes whose MIME matches their magic', async () => {
    const jpegBuffer = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]).buffer as ArrayBuffer;
    const validFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(jpegBuffer, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' } }),
    );
    const validClient = new WebNovelMetadataCollectorClient('http://127.0.0.1:8000', validFetch as typeof fetch);

    await expect(validClient.downloadCover('cover_ref_12345678')).resolves.toMatchObject({
      contentType: 'image/jpeg',
      byteLength: 5,
    });

    const mismatchedFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(jpegBuffer, { headers: { 'Content-Type': 'image/png' } }),
    );
    const mismatchedClient = new WebNovelMetadataCollectorClient(
      'http://127.0.0.1:8000',
      mismatchedFetch as typeof fetch,
    );
    await expect(mismatchedClient.downloadCover('cover_ref_12345678')).rejects.toMatchObject({
      code: 'invalid_cover',
    });

    const oversizedFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '10485761' } }),
    );
    const oversizedClient = new WebNovelMetadataCollectorClient(
      'http://127.0.0.1:8000',
      oversizedFetch as typeof fetch,
    );
    await expect(oversizedClient.downloadCover('cover_ref_12345678')).rejects.toMatchObject({
      code: 'cover_too_large',
    });
  });

  it('maps the manual adult-auth operations without accepting secret credentials', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        available: true,
        browser_running: true,
        browser_presentation: 'local_window',
        enabled_platforms: ['ridi'],
        last_error: null,
      }),
    );
    const client = new WebNovelMetadataCollectorClient('http://127.0.0.1:8000', fetchMock as typeof fetch);

    await expect(client.openAuthBrowser('ridi')).resolves.toMatchObject({
      browserRunning: true,
      enabledPlatforms: ['ridi'],
    });
    await client.setAuthPlatformEnabled('ridi', true);
    await client.closeAuthBrowser();
    await client.clearAuthSession();

    expect(fetchMock.mock.calls.map(([url, request]) => [String(url), (request as RequestInit).method])).toEqual([
      ['http://127.0.0.1:8000/api/v1/auth/ridi/open', 'POST'],
      ['http://127.0.0.1:8000/api/v1/auth/ridi', 'PUT'],
      ['http://127.0.0.1:8000/api/v1/auth/browser/close', 'POST'],
      ['http://127.0.0.1:8000/api/v1/auth/session', 'DELETE'],
    ]);
  });

  it('reads bounded remote-browser JPEG frames and sends typed actions', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(null, { status: 204 });
      return new Response(jpeg, {
        headers: {
          'Content-Type': 'image/jpeg',
          'X-Moya-Frame-Revision': '4',
          'X-Moya-Frame-Width': '1280',
          'X-Moya-Frame-Height': '800',
        },
      });
    });
    const client = new WebNovelMetadataCollectorClient('http://127.0.0.1:8000', fetchMock as typeof fetch);

    await expect(client.authBrowserFrame(3)).resolves.toMatchObject({
      revision: 4,
      width: 1280,
      height: 800,
    });
    await client.authBrowserAction({ action: 'scroll', deltaY: 320 });

    expect(String(fetchMock.mock.calls[0]![0])).toContain('after_revision=3');
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({ action: 'scroll', delta_y: 320 });
  });
});
