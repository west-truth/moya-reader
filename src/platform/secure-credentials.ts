import { detectPlatformRuntime, type PlatformRuntimeInfo } from './runtime';

export const API_AUTH_TOKEN_STORAGE_KEY = 'noveldesk.apiAuthToken';

export const APP_CREDENTIAL_KEYS = {
  serverApiToken: 'server_api_token',
  cloudVaultDropboxOAuth: 'cloud_vault_dropbox_oauth',
  cloudVaultPassphrase: 'cloud_vault_passphrase',
} as const;

export type AppCredentialKey = (typeof APP_CREDENTIAL_KEYS)[keyof typeof APP_CREDENTIAL_KEYS];

export interface AppCredentialStatus {
  readonly key: AppCredentialKey;
  readonly configured: boolean;
  readonly source?: 'android_keystore' | 'desktop_secure_store';
}

export interface NativeCredentialGateway {
  status(key: AppCredentialKey): Promise<AppCredentialStatus>;
  get(key: AppCredentialKey): Promise<string>;
  set(key: AppCredentialKey, secretValue: string): Promise<AppCredentialStatus>;
  delete(key: AppCredentialKey): Promise<AppCredentialStatus>;
}

interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

class TauriNativeCredentialGateway implements NativeCredentialGateway {
  constructor(private readonly invoke: Invoke) {}

  status(key: AppCredentialKey): Promise<AppCredentialStatus> {
    return this.invoke('app_credential_status', { key });
  }

  get(key: AppCredentialKey): Promise<string> {
    return this.invoke('app_credential_get', { key });
  }

  set(key: AppCredentialKey, secretValue: string): Promise<AppCredentialStatus> {
    return this.invoke('app_credential_set', { key, secretValue });
  }

  delete(key: AppCredentialKey): Promise<AppCredentialStatus> {
    return this.invoke('app_credential_delete', { key });
  }
}

export interface AppCredentialStoreDependencies {
  readonly runtime: PlatformRuntimeInfo;
  readonly storage?: LocalStorageLike;
  readonly nativeGateway?: NativeCredentialGateway;
}

function readStorage(storage: LocalStorageLike | undefined, key: string): string {
  try {
    return storage?.getItem(key)?.trim() ?? '';
  } catch {
    return '';
  }
}

function removeStorage(storage: LocalStorageLike | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Native migration and restricted browser contexts remain usable without legacy cleanup.
  }
}

export class AppCredentialStore {
  private initialized = false;
  private serverApiToken?: string;

  constructor(private readonly dependencies: AppCredentialStoreDependencies) {}

  get usesNativeSecureStore(): boolean {
    return this.dependencies.runtime.hasTauri;
  }

  get usesNativeServerTokenStore(): boolean {
    return this.dependencies.runtime.kind === 'tauri-mobile';
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.usesNativeServerTokenStore) {
      this.initialized = true;
      return;
    }

    const native = this.requireNativeGateway();
    const status = await native.status(APP_CREDENTIAL_KEYS.serverApiToken);
    if (status.configured) {
      this.serverApiToken = (await native.get(APP_CREDENTIAL_KEYS.serverApiToken)).trim() || undefined;
      removeStorage(this.dependencies.storage, API_AUTH_TOKEN_STORAGE_KEY);
    } else {
      const legacyToken = readStorage(this.dependencies.storage, API_AUTH_TOKEN_STORAGE_KEY);
      if (legacyToken) {
        await native.set(APP_CREDENTIAL_KEYS.serverApiToken, legacyToken);
        this.serverApiToken = legacyToken;
        removeStorage(this.dependencies.storage, API_AUTH_TOKEN_STORAGE_KEY);
      }
    }
    this.initialized = true;
  }

  serverTokenDraft(): string {
    if (this.usesNativeServerTokenStore) return '';
    return readStorage(this.dependencies.storage, API_AUTH_TOKEN_STORAGE_KEY);
  }

  serverTokenForRequest(): string | undefined {
    if (this.usesNativeServerTokenStore) return this.serverApiToken;
    return readStorage(this.dependencies.storage, API_AUTH_TOKEN_STORAGE_KEY) || undefined;
  }

  serverTokenConfigured(): boolean {
    return Boolean(this.serverTokenForRequest());
  }

  async saveServerToken(value: string): Promise<void> {
    const normalized = value.trim();
    if (this.usesNativeServerTokenStore) {
      const native = this.requireNativeGateway();
      if (normalized) {
        await native.set(APP_CREDENTIAL_KEYS.serverApiToken, normalized);
        this.serverApiToken = normalized;
      } else {
        await native.delete(APP_CREDENTIAL_KEYS.serverApiToken);
        this.serverApiToken = undefined;
      }
      removeStorage(this.dependencies.storage, API_AUTH_TOKEN_STORAGE_KEY);
      this.initialized = true;
      return;
    }

    try {
      if (normalized) this.dependencies.storage?.setItem(API_AUTH_TOKEN_STORAGE_KEY, normalized);
      else this.dependencies.storage?.removeItem(API_AUTH_TOKEN_STORAGE_KEY);
    } catch {
      // Preserve the existing browser behavior in restricted storage contexts.
    }
  }

  async getCloudVaultDropboxCredential(): Promise<string | undefined> {
    if (!this.usesNativeSecureStore) return undefined;
    const native = this.requireNativeGateway();
    const status = await native.status(APP_CREDENTIAL_KEYS.cloudVaultDropboxOAuth);
    if (!status.configured) return undefined;
    return native.get(APP_CREDENTIAL_KEYS.cloudVaultDropboxOAuth);
  }

  async saveCloudVaultDropboxCredential(value: string): Promise<void> {
    if (!this.usesNativeSecureStore) {
      throw new Error('Native Cloud Vault credential storage is unavailable.');
    }
    await this.requireNativeGateway().set(APP_CREDENTIAL_KEYS.cloudVaultDropboxOAuth, value);
  }

  async deleteCloudVaultDropboxCredential(): Promise<void> {
    if (!this.usesNativeSecureStore) return;
    await this.requireNativeGateway().delete(APP_CREDENTIAL_KEYS.cloudVaultDropboxOAuth);
  }

  async getCloudVaultPassphrase(): Promise<string | undefined> {
    if (!this.usesNativeSecureStore) return undefined;
    const native = this.requireNativeGateway();
    const status = await native.status(APP_CREDENTIAL_KEYS.cloudVaultPassphrase);
    if (!status.configured) return undefined;
    return native.get(APP_CREDENTIAL_KEYS.cloudVaultPassphrase);
  }

  async saveCloudVaultPassphrase(value: string): Promise<void> {
    if (!this.usesNativeSecureStore) {
      throw new Error('Native Cloud Vault credential storage is unavailable.');
    }
    await this.requireNativeGateway().set(APP_CREDENTIAL_KEYS.cloudVaultPassphrase, value);
  }

  async deleteCloudVaultPassphrase(): Promise<void> {
    if (!this.usesNativeSecureStore) return;
    await this.requireNativeGateway().delete(APP_CREDENTIAL_KEYS.cloudVaultPassphrase);
  }

  private requireNativeGateway(): NativeCredentialGateway {
    if (!this.dependencies.nativeGateway) {
      throw new Error('Native secure credential storage is unavailable.');
    }
    return this.dependencies.nativeGateway;
  }
}

let defaultStore: AppCredentialStore | undefined;

function globalStorage(): LocalStorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

async function createDefaultStore(): Promise<AppCredentialStore> {
  const runtime = detectPlatformRuntime();
  const storage = globalStorage();
  if (!runtime.hasTauri) return new AppCredentialStore({ runtime, storage });
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return new AppCredentialStore({
      runtime,
      storage,
      nativeGateway: new TauriNativeCredentialGateway(invoke),
    });
  } catch {
    return new AppCredentialStore({ runtime, storage });
  }
}

async function ensureDefaultStore(): Promise<AppCredentialStore> {
  if (defaultStore) return defaultStore;
  defaultStore = await createDefaultStore();
  return defaultStore;
}

function currentDefaultStore(): AppCredentialStore {
  if (defaultStore) return defaultStore;
  const runtime = detectPlatformRuntime();
  defaultStore = new AppCredentialStore({ runtime, storage: globalStorage() });
  return defaultStore;
}

export async function initializeAppCredentialStore(): Promise<void> {
  const store = await ensureDefaultStore();
  await store.initialize();
}

export function getApiAuthTokenDraft(): string {
  return currentDefaultStore().serverTokenDraft();
}

export function resolveStoredApiAuthToken(): string | undefined {
  return currentDefaultStore().serverTokenForRequest();
}

export function storedApiAuthTokenConfigured(): boolean {
  return currentDefaultStore().serverTokenConfigured();
}

export function apiAuthTokenUsesNativeSecureStore(): boolean {
  return detectPlatformRuntime().kind === 'tauri-mobile';
}

export async function saveApiAuthToken(value: string): Promise<void> {
  await (await ensureDefaultStore()).saveServerToken(value);
}

export function cloudVaultUsesNativeSecureStore(): boolean {
  return detectPlatformRuntime().hasTauri;
}

export async function getNativeCloudVaultDropboxCredential(): Promise<string | undefined> {
  return (await ensureDefaultStore()).getCloudVaultDropboxCredential();
}

export async function saveNativeCloudVaultDropboxCredential(value: string): Promise<void> {
  await (await ensureDefaultStore()).saveCloudVaultDropboxCredential(value);
}

export async function deleteNativeCloudVaultDropboxCredential(): Promise<void> {
  await (await ensureDefaultStore()).deleteCloudVaultDropboxCredential();
}

export async function getNativeCloudVaultPassphrase(): Promise<string | undefined> {
  return (await ensureDefaultStore()).getCloudVaultPassphrase();
}

export async function saveNativeCloudVaultPassphrase(value: string): Promise<void> {
  await (await ensureDefaultStore()).saveCloudVaultPassphrase(value);
}

export async function deleteNativeCloudVaultPassphrase(): Promise<void> {
  await (await ensureDefaultStore()).deleteCloudVaultPassphrase();
}

export function resetAppCredentialStoreForTests(): void {
  defaultStore = undefined;
}
