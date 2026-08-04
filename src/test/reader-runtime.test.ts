import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createReaderRuntime,
  getOrCreateRemoteDeviceId,
  getStoredSyncApiBaseUrl,
  normalizeSyncApiBaseUrl,
  REMOTE_DEVICE_ID_STORAGE_KEY,
  saveStoredSyncApiBaseUrl,
  SYNC_API_BASE_URL_STORAGE_KEY,
  testSyncApiConnection,
} from '../repositories/reader-runtime';

describe('reader runtime remote device id', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reuses the stored hosted browser device id', () => {
    const store = new Map<string, string>([[REMOTE_DEVICE_ID_STORAGE_KEY, 'device_web_existing']]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => store.set(key, value)),
    });

    expect(getOrCreateRemoteDeviceId()).toBe('device_web_existing');
    expect(globalThis.localStorage.setItem).not.toHaveBeenCalled();
  });

  it('creates and stores a hosted browser device id when none exists', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => store.set(key, value)),
    });

    const id = getOrCreateRemoteDeviceId();

    expect(id).toMatch(/^device_web_/);
    expect(store.get(REMOTE_DEVICE_ID_STORAGE_KEY)).toBe(id);
  });

  it('falls back to an ephemeral device id if storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => {
        throw new Error('blocked');
      }),
      setItem: vi.fn(),
    });

    expect(getOrCreateRemoteDeviceId()).toMatch(/^device_web_/);
  });
});

describe('reader runtime connected server settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('normalizes server roots to the API base URL', () => {
    expect(normalizeSyncApiBaseUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/api');
    expect(normalizeSyncApiBaseUrl('http://127.0.0.1:3000/api/')).toBe('http://127.0.0.1:3000/api');
    expect(normalizeSyncApiBaseUrl('/api/')).toBe('/api');
  });

  it('stores only the normalized connected server URL', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => store.set(key, value)),
      removeItem: vi.fn((key: string) => store.delete(key)),
    });

    expect(saveStoredSyncApiBaseUrl('http://localhost:3000/')).toBe('http://localhost:3000/api');
    expect(store.get(SYNC_API_BASE_URL_STORAGE_KEY)).toBe('http://localhost:3000/api');
    expect(getStoredSyncApiBaseUrl()).toBe('http://localhost:3000/api');

    expect(saveStoredSyncApiBaseUrl('   ')).toBe('');
    expect(store.has(SYNC_API_BASE_URL_STORAGE_KEY)).toBe(false);
  });

  it('tests readiness without returning or storing secrets', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ready: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await testSyncApiConnection('http://localhost:3000', 'reader-token');

    expect(result).toEqual({
      ok: true,
      normalizedBaseUrl: 'http://localhost:3000/api',
      status: 200,
      message: '서버 readiness 확인에 성공했습니다.',
    });
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/ready', {
      headers: { Authorization: 'Bearer reader-token' },
    });
  });

  it('creates local connected services from a stored self-host API URL', () => {
    const store = new Map<string, string>([[SYNC_API_BASE_URL_STORAGE_KEY, 'http://localhost:8787/api']]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => store.set(key, value)),
      removeItem: vi.fn((key: string) => store.delete(key)),
    });
    vi.stubEnv('VITE_READER_BACKEND', 'local');
    vi.stubEnv('VITE_SYNC_API_BASE_URL', '');

    const runtime = createReaderRuntime();

    expect(runtime.mode).toBe('local');
    expect(runtime.apiBaseUrl).toBe('http://localhost:8787/api');
    expect(runtime.remoteApiClient).toBeUndefined();
    expect(runtime.syncApiClient).toBeDefined();
    expect(runtime.syncService).toBeDefined();
    expect(runtime.serverAttachService).toBeDefined();
  });

  it('keeps plain local runtime offline when no connected server URL is configured', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubEnv('VITE_READER_BACKEND', 'local');
    vi.stubEnv('VITE_SYNC_API_BASE_URL', '');

    const runtime = createReaderRuntime();

    expect(runtime.mode).toBe('local');
    expect(runtime.apiBaseUrl).toBeUndefined();
    expect(runtime.syncApiClient).toBeUndefined();
    expect(runtime.syncService).toBeUndefined();
    expect(runtime.serverAttachService).toBeUndefined();
  });

  it('creates hosted remote runtime with one API client for reader and provider work', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => store.set(key, value)),
      removeItem: vi.fn((key: string) => store.delete(key)),
    });
    vi.stubEnv('VITE_READER_BACKEND', 'remote');
    vi.stubEnv('VITE_API_BASE_URL', '/api/');

    const runtime = createReaderRuntime();

    expect(runtime.mode).toBe('remote');
    expect(runtime.apiBaseUrl).toBe('/api');
    expect(runtime.remoteApiClient).toBeDefined();
    expect(runtime.syncApiClient).toBe(runtime.remoteApiClient);
    expect(runtime.syncService).toBeUndefined();
    expect(runtime.serverAttachService).toBeUndefined();
    expect(store.get(REMOTE_DEVICE_ID_STORAGE_KEY)).toMatch(/^device_web_/);
  });
});
