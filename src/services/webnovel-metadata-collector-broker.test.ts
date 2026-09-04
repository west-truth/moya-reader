import { describe, expect, it, vi } from 'vitest';
import {
  WEBNOVEL_METADATA_COLLECTOR_SETTINGS_STORAGE_KEY,
  WebNovelMetadataCollectorBroker,
  evaluateWebNovelMetadataCollectorAutomaticApply,
  type WebNovelMetadataCollectorClientPort,
  type WebNovelMetadataCollectorSettingsStorage,
} from './webnovel-metadata-collector-broker';
import {
  WebNovelMetadataCollectorError,
  type WebNovelMetadataCollectorHealth,
  type WebNovelMetadataCollectorResolveResult,
} from './webnovel-metadata-collector-client';

class MemoryStorage implements WebNovelMetadataCollectorSettingsStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const health: WebNovelMetadataCollectorHealth = {
  status: 'ok',
  service: 'webnovel-metadata-collector',
  version: '0.1.0',
  apiVersion: 1,
  capabilities: {
    resolve: { version: 1 },
    batchResolve: { version: 1, maxItems: 50 },
    coverRef: {
      version: 1,
      path: '/api/v1/covers/{cover_ref}',
      ttlSeconds: 900,
      maxBytes: 10 * 1024 * 1024,
      contentTypes: ['image/jpeg', 'image/png', 'image/webp'],
    },
    adultAuth: { version: 1, available: true, browserPresentation: 'local_window', platforms: ['ridi'] },
  },
};

const result: WebNovelMetadataCollectorResolveResult = {
  query: '테스트 작품',
  author: '작가',
  status: 'found',
  confidence: 1,
  matchType: 'exact_title_and_author',
  metadataQuality: 'full',
  metadata: {
    title: '테스트 작품',
    author: '작가',
    platform: 'ridi',
    platformWorkId: 'work-42',
    sourceUrl: 'https://ridibooks.com/books/123/42',
    coverUrl: 'https://img.ridicdn.net/cover.jpg',
    description: '소개',
    genres: ['판타지'],
    tags: ['성장'],
    status: 'completed',
    matchScore: 1,
    fetchedAt: '2026-08-27T10:00:00Z',
  },
  coverRef: 'cover_ref_12345678',
  searchedPlatforms: 5,
  failedPlatforms: [],
  platformErrors: {},
  skippedPlatforms: [],
  authenticatedSearch: false,
  autoApplyEligible: true,
  autoApplyReasons: [],
  fetchedAt: '2026-08-27T10:00:00Z',
};

function clientPort(overrides: Partial<WebNovelMetadataCollectorClientPort> = {}): WebNovelMetadataCollectorClientPort {
  const auth = {
    available: true,
    browserRunning: false,
    browserPresentation: 'local_window' as const,
    enabledPlatforms: ['ridi'] as const,
  };
  return {
    health: vi.fn(async () => health),
    resolve: vi.fn(async () => result),
    resolveBatch: vi.fn(async () => ({ results: [result], fetchedAt: result.fetchedAt })),
    downloadCover: vi.fn(async () => ({
      blob: new Blob(['cover'], { type: 'image/jpeg' }),
      contentType: 'image/jpeg' as const,
      byteLength: 5,
    })),
    authStatus: vi.fn(async () => auth),
    openAuthBrowser: vi.fn(async () => ({ ...auth, browserRunning: true })),
    setAuthPlatformEnabled: vi.fn(async () => auth),
    closeAuthBrowser: vi.fn(async () => auth),
    clearAuthSession: vi.fn(async () => ({ ...auth, enabledPlatforms: [] })),
    authBrowserFrame: vi.fn(async () => undefined),
    authBrowserAction: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('WebNovelMetadataCollectorBroker', () => {
  it('persists extension-owned non-secret settings and fails damaged state to conservative defaults', () => {
    const storage = new MemoryStorage();
    const broker = new WebNovelMetadataCollectorBroker({ storage });

    expect(broker.getSettings()).toEqual({
      endpoint: 'http://127.0.0.1:8000',
      includeAdult: false,
      automaticLookup: false,
      automaticApply: 'off',
    });
    broker.updateSettings({
      endpoint: 'https://collector.example/moya/',
      includeAdult: true,
      automaticLookup: true,
      automaticApply: 'missing_fields',
    });

    expect(JSON.parse(storage.values.get(WEBNOVEL_METADATA_COLLECTOR_SETTINGS_STORAGE_KEY)!)).toEqual({
      schemaVersion: 1,
      settings: {
        endpoint: 'https://collector.example/moya',
        includeAdult: true,
        automaticLookup: true,
        automaticApply: 'missing_fields',
      },
    });
    expect(new WebNovelMetadataCollectorBroker({ storage }).getSettings()).toEqual(broker.getSettings());

    storage.values.set(WEBNOVEL_METADATA_COLLECTOR_SETTINGS_STORAGE_KEY, '{damaged');
    expect(new WebNovelMetadataCollectorBroker({ storage }).getSettings().automaticApply).toBe('off');
    expect(() => broker.updateSettings({ endpoint: 'http://remote.example' })).toThrow('설정이 올바르지');
  });

  it('shares automation preferences without replacing the device-specific endpoint', () => {
    const broker = new WebNovelMetadataCollectorBroker({ storage: null });
    broker.updateSettings({ endpoint: 'https://device-only.example', includeAdult: false });

    broker.applySharedSettings({
      schemaVersion: 1,
      includeAdult: true,
      automaticLookup: true,
      automaticApply: 'missing_fields',
    });

    expect(broker.getSettings()).toEqual({
      endpoint: 'https://device-only.example',
      includeAdult: true,
      automaticLookup: true,
      automaticApply: 'missing_fields',
    });
    expect(broker.getSharedSettings()).toEqual({
      schemaVersion: 1,
      includeAdult: true,
      automaticLookup: true,
      automaticApply: 'missing_fields',
    });
  });

  it('publishes stable connection health and manual adult-auth state for extension detail UI', async () => {
    const client = clientPort();
    const broker = new WebNovelMetadataCollectorBroker({
      storage: null,
      clientFactory: () => client,
      now: () => new Date('2026-08-27T11:00:00Z'),
    });
    const listener = vi.fn();
    broker.subscribe(listener);

    await expect(broker.connect()).resolves.toMatchObject({
      connectionState: 'connected',
      health: { version: '0.1.0' },
      auth: { enabledPlatforms: ['ridi'] },
      lastCheckedAt: '2026-08-27T11:00:00.000Z',
    });
    expect(listener).toHaveBeenCalledTimes(2);

    await broker.openAuthBrowser('ridi');
    expect(broker.getSnapshot().auth?.browserRunning).toBe(true);
    broker.disconnect();
    expect(broker.getSnapshot()).toMatchObject({ connectionState: 'disconnected' });
    expect(broker.getSnapshot().health).toBeUndefined();
  });

  it('exposes a managed desktop connection without persisting its process details', async () => {
    const stop = vi.fn(async () => undefined);
    const broker = new WebNovelMetadataCollectorBroker({
      storage: null,
      managedRuntime: { client: clientPort(), stop },
    });

    expect(broker.connectionMode).toBe('managed');
    await expect(broker.connect()).resolves.toMatchObject({ connectionState: 'connected' });
    await broker.stopManagedRuntime();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(broker.getSettings().endpoint).toBe('http://127.0.0.1:8000');
  });

  it('records connection failures without turning a missing optional companion into an unhandled rejection', async () => {
    const client = clientPort({
      health: vi.fn(async () => {
        throw new WebNovelMetadataCollectorError('unavailable', '수집기가 실행 중이 아닙니다.');
      }),
    });
    const broker = new WebNovelMetadataCollectorBroker({ storage: null, clientFactory: () => client });

    await expect(broker.connect()).resolves.toMatchObject({
      connectionState: 'unavailable',
      connectionIssue: { code: 'unavailable', message: '수집기가 실행 중이 아닙니다.' },
    });
  });

  it('applies current adult settings to lookups and keeps a cover ref bound to its issuing endpoint', async () => {
    const oldClient = clientPort();
    const newClient = clientPort();
    const clients: Readonly<Record<string, WebNovelMetadataCollectorClientPort>> = {
      'http://127.0.0.1:8000': oldClient,
      'https://collector.example': newClient,
    };
    const broker = new WebNovelMetadataCollectorBroker({
      storage: null,
      clientFactory: (endpoint) => clients[endpoint]!,
    });
    broker.updateSettings({ includeAdult: true });

    await broker.resolve({ query: '테스트 작품', author: '작가' });
    expect(oldClient.resolveBatch).toHaveBeenCalledWith(
      [{ query: '테스트 작품', author: '작가', includeAdult: true }],
      undefined,
    );
    expect(oldClient.resolve).not.toHaveBeenCalled();

    broker.updateSettings({ endpoint: 'https://collector.example' });
    await broker.downloadCover('cover_ref_12345678');
    expect(oldClient.downloadCover).toHaveBeenCalledWith('cover_ref_12345678', undefined);
    expect(newClient.downloadCover).not.toHaveBeenCalled();
  });

  it('separates provider match safety from the host automatic-apply policy', () => {
    expect(evaluateWebNovelMetadataCollectorAutomaticApply('off', result)).toEqual({
      eligible: false,
      mode: 'off',
      reasons: ['policy_off'],
    });
    expect(evaluateWebNovelMetadataCollectorAutomaticApply('missing_fields', result)).toEqual({
      eligible: true,
      mode: 'missing_fields',
      reasons: [],
    });
    expect(
      evaluateWebNovelMetadataCollectorAutomaticApply('missing_fields', {
        ...result,
        autoApplyEligible: false,
        autoApplyReasons: ['partial_metadata'],
      }),
    ).toMatchObject({ eligible: false, reasons: ['partial_metadata'] });
  });
});
