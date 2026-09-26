import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPlatformWebNovelMetadataCollector,
  resolveSelfHostedWebNovelMetadataCollectorEndpoint,
} from './webnovel-metadata-collector';
import type { PlatformRuntimeInfo } from './runtime';

const desktop: PlatformRuntimeInfo = { kind: 'tauri-desktop', hasTauri: true, isMobileWebView: false, userAgent: '' };
const browser: PlatformRuntimeInfo = { kind: 'browser', hasTauri: false, isMobileWebView: false, userAgent: '' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function healthResponse() {
  return Response.json({
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
        max_bytes: 10485760,
        content_types: ['image/jpeg', 'image/png', 'image/webp'],
      },
      adult_auth: {
        version: 1,
        available: false,
        browser_presentation: 'remote_frame',
        platforms: [],
        direct_login_platforms: [],
      },
    },
  });
}

describe('self-hosted webnovel metadata collector endpoint', () => {
  it('derives the gateway from the existing API base instead of a proxy-specific hostname', () => {
    expect(
      resolveSelfHostedWebNovelMetadataCollectorEndpoint({
        backendMode: 'remote',
        apiBaseUrl: '/api',
        browserOrigin: 'https://moya.example',
      }),
    ).toBe('https://moya.example/api/integrations/webnovel-metadata');

    expect(
      resolveSelfHostedWebNovelMetadataCollectorEndpoint({
        backendMode: 'remote',
        apiBaseUrl: 'https://reader.example/custom-api/',
        browserOrigin: 'https://reader.example',
      }),
    ).toBe('https://reader.example/custom-api/integrations/webnovel-metadata');
  });

  it('keeps local browser builds on the explicit external companion mode', () => {
    expect(
      resolveSelfHostedWebNovelMetadataCollectorEndpoint({
        backendMode: 'local',
        apiBaseUrl: '/api',
        browserOrigin: 'http://127.0.0.1:1421',
      }),
    ).toBeUndefined();
  });

  it('rejects malformed or credential-bearing API bases', () => {
    expect(
      resolveSelfHostedWebNovelMetadataCollectorEndpoint({
        backendMode: 'remote',
        apiBaseUrl: 'https://user:password@reader.example/api',
        browserOrigin: 'https://reader.example',
      }),
    ).toBeUndefined();

    expect(
      resolveSelfHostedWebNovelMetadataCollectorEndpoint({
        backendMode: 'remote',
        apiBaseUrl: 'https://reader-api.example/api',
        browserOrigin: 'https://reader.example',
      }),
    ).toBeUndefined();
  });
});

describe('collector runtime selection', () => {
  it('uses the selected desktop server gateway with its bearer token and no native startup', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => healthResponse());
    vi.stubGlobal('fetch', fetchImpl);
    const broker = createPlatformWebNovelMetadataCollector(desktop, {
      apiBaseUrl: 'http://127.0.0.1:3579/api',
      getAuthToken: () => 'owner-token',
    });
    expect((await broker.connect()).connectionState).toBe('connected');
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:3579/api/integrations/webnovel-metadata/health');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer owner-token');
    expect(init?.credentials).toBe('omit');
    expect(init?.redirect).toBe('error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary self-host browsers on same-origin cookie authentication', async () => {
    vi.stubEnv('VITE_READER_BACKEND', 'remote');
    vi.stubEnv('VITE_API_BASE_URL', '/api');
    vi.stubGlobal('location', { origin: 'https://moya.example' });
    const fetchImpl = vi.fn<typeof fetch>(async () => healthResponse());
    vi.stubGlobal('fetch', fetchImpl);
    expect((await createPlatformWebNovelMetadataCollector(browser).connect()).connectionState).toBe('connected');
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://moya.example/api/integrations/webnovel-metadata/health');
    expect(init?.credentials).toBe('same-origin');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });

  it('preserves the standalone desktop managed client without a server connection', () => {
    const broker = createPlatformWebNovelMetadataCollector(desktop);
    expect(broker.connectionMode).toBe('managed');
  });
});
