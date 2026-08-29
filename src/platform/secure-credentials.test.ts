import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformRuntimeInfo } from './runtime';
import {
  APP_CREDENTIAL_KEYS,
  API_AUTH_TOKEN_STORAGE_KEY,
  AppCredentialStore,
  type AppCredentialKey,
  type AppCredentialStatus,
  type NativeCredentialGateway,
} from './secure-credentials';

function runtime(kind: PlatformRuntimeInfo['kind']): PlatformRuntimeInfo {
  return {
    kind,
    hasTauri: kind !== 'browser',
    isMobileWebView: kind === 'tauri-mobile',
    userAgent: kind === 'tauri-mobile' ? 'Android' : 'Browser',
  };
}

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
}

function nativeGateway(initial: Partial<Record<AppCredentialKey, string>> = {}) {
  const values = new Map<AppCredentialKey, string>(Object.entries(initial) as [AppCredentialKey, string][]);
  const statusFor = (key: AppCredentialKey): AppCredentialStatus => ({
    key,
    configured: values.has(key),
    source: values.has(key) ? 'android_keystore' : undefined,
  });
  const gateway: NativeCredentialGateway = {
    status: vi.fn(async (key) => statusFor(key)),
    get: vi.fn(async (key) => {
      const value = values.get(key);
      if (!value) throw new Error('not configured');
      return value;
    }),
    set: vi.fn(async (key, value) => {
      values.set(key, value);
      return statusFor(key);
    }),
    delete: vi.fn(async (key) => {
      values.delete(key);
      return statusFor(key);
    }),
  };
  return { gateway, values };
}

describe('AppCredentialStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('migrates an Android legacy bearer token to native storage and deletes the plaintext copy', async () => {
    const local = storage({ [API_AUTH_TOKEN_STORAGE_KEY]: ' legacy-token ' });
    const native = nativeGateway();
    const store = new AppCredentialStore({
      runtime: runtime('tauri-mobile'),
      storage: local,
      nativeGateway: native.gateway,
    });

    await store.initialize();

    expect(native.gateway.set).toHaveBeenCalledWith(APP_CREDENTIAL_KEYS.serverApiToken, 'legacy-token');
    expect(local.values.has(API_AUTH_TOKEN_STORAGE_KEY)).toBe(false);
    expect(store.serverTokenForRequest()).toBe('legacy-token');
    expect(store.serverTokenDraft()).toBe('');
  });

  it('prefers the Keystore token and clears any stale browser copy', async () => {
    const local = storage({ [API_AUTH_TOKEN_STORAGE_KEY]: 'stale-token' });
    const native = nativeGateway({ [APP_CREDENTIAL_KEYS.serverApiToken]: 'native-token' });
    const store = new AppCredentialStore({
      runtime: runtime('tauri-mobile'),
      storage: local,
      nativeGateway: native.gateway,
    });

    await store.initialize();

    expect(store.serverTokenForRequest()).toBe('native-token');
    expect(native.gateway.set).not.toHaveBeenCalled();
    expect(local.values.has(API_AUTH_TOKEN_STORAGE_KEY)).toBe(false);
  });

  it('keeps a legacy token recoverable when the Keystore migration fails', async () => {
    const local = storage({ [API_AUTH_TOKEN_STORAGE_KEY]: 'legacy-token' });
    const native = nativeGateway();
    vi.mocked(native.gateway.set).mockRejectedValueOnce(new Error('keystore unavailable'));
    const store = new AppCredentialStore({
      runtime: runtime('tauri-mobile'),
      storage: local,
      nativeGateway: native.gateway,
    });

    await expect(store.initialize()).rejects.toThrow('keystore unavailable');

    expect(local.values.get(API_AUTH_TOKEN_STORAGE_KEY)).toBe('legacy-token');
    expect(store.serverTokenForRequest()).toBeUndefined();
  });

  it('keeps existing browser persistence behavior outside Tauri', async () => {
    const local = storage();
    const store = new AppCredentialStore({ runtime: runtime('browser'), storage: local });

    await store.saveServerToken('browser-token');

    expect(store.serverTokenDraft()).toBe('browser-token');
    expect(store.serverTokenForRequest()).toBe('browser-token');
    expect(local.values.get(API_AUTH_TOKEN_STORAGE_KEY)).toBe('browser-token');
  });

  it.each(['tauri-mobile', 'tauri-desktop'] as const)(
    'stores Dropbox OAuth and the remembered vault passphrase in the %s native gateway',
    async (runtimeKind) => {
      const local = storage();
      const native = nativeGateway();
      const store = new AppCredentialStore({
        runtime: runtime(runtimeKind),
        storage: local,
        nativeGateway: native.gateway,
      });
      const credential = JSON.stringify({ accessToken: 'access', refreshToken: 'refresh' });

      await store.saveCloudVaultDropboxCredential(credential);
      await store.saveCloudVaultPassphrase('remembered-passphrase');

      expect(await store.getCloudVaultDropboxCredential()).toBe(credential);
      expect(await store.getCloudVaultPassphrase()).toBe('remembered-passphrase');
      expect(local.setItem).not.toHaveBeenCalled();
      await store.deleteCloudVaultDropboxCredential();
      await store.deleteCloudVaultPassphrase();
      expect(await store.getCloudVaultDropboxCredential()).toBeUndefined();
      expect(await store.getCloudVaultPassphrase()).toBeUndefined();
    },
  );

  it('does not block desktop startup on an unused self-host token keyring read', async () => {
    const local = storage({ [API_AUTH_TOKEN_STORAGE_KEY]: 'desktop-token' });
    const native = nativeGateway();
    const store = new AppCredentialStore({
      runtime: runtime('tauri-desktop'),
      storage: local,
      nativeGateway: native.gateway,
    });

    await store.initialize();

    expect(native.gateway.status).not.toHaveBeenCalled();
    expect(native.gateway.set).not.toHaveBeenCalled();
    expect(local.values.get(API_AUTH_TOKEN_STORAGE_KEY)).toBe('desktop-token');
    expect(store.serverTokenForRequest()).toBe('desktop-token');
  });
});
