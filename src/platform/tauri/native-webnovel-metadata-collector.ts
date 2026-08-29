import { WebNovelMetadataCollectorClient } from '../../services/webnovel-metadata-collector-client';
import type { WebNovelMetadataCollectorClientPort } from '../../services/webnovel-metadata-collector-broker';

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface ManagedMetadataCollectorConnection {
  readonly endpoint: string;
}

function sessionToken(cryptoImpl: Pick<Crypto, 'getRandomValues'>): string {
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

export class NativeWebNovelMetadataCollectorClient implements WebNovelMetadataCollectorClientPort {
  private clientPromise?: Promise<WebNovelMetadataCollectorClient>;

  constructor(
    private readonly invokeImpl?: TauriInvoke,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly cryptoImpl: Pick<Crypto, 'getRandomValues'> = globalThis.crypto,
  ) {}

  private async invoke(): Promise<TauriInvoke> {
    if (this.invokeImpl) return this.invokeImpl;
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke;
  }

  private client(): Promise<WebNovelMetadataCollectorClient> {
    if (this.clientPromise) return this.clientPromise;
    const token = sessionToken(this.cryptoImpl);
    this.clientPromise = this.invoke()
      .then((invoke) =>
        invoke<ManagedMetadataCollectorConnection>('desktop_metadata_collector_start', { sessionToken: token }),
      )
      .then(({ endpoint }) => {
        const authenticatedFetch: typeof fetch = (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set('X-Moya-Collector-Token', token);
          return this.fetchImpl(input, { ...init, headers });
        };
        return new WebNovelMetadataCollectorClient(endpoint, authenticatedFetch);
      })
      .catch((error) => {
        this.clientPromise = undefined;
        throw error;
      });
    return this.clientPromise;
  }

  async stop(): Promise<void> {
    this.clientPromise = undefined;
    const invoke = await this.invoke();
    await invoke('desktop_metadata_collector_stop');
  }

  health(signal?: AbortSignal) {
    return this.client().then((client) => client.health(signal));
  }

  resolve(input: Parameters<WebNovelMetadataCollectorClient['resolve']>[0], signal?: AbortSignal) {
    return this.client().then((client) => client.resolve(input, signal));
  }

  resolveBatch(input: Parameters<WebNovelMetadataCollectorClient['resolveBatch']>[0], signal?: AbortSignal) {
    return this.client().then((client) => client.resolveBatch(input, signal));
  }

  downloadCover(coverRef: string, signal?: AbortSignal) {
    return this.client().then((client) => client.downloadCover(coverRef, signal));
  }

  authStatus(signal?: AbortSignal) {
    return this.client().then((client) => client.authStatus(signal));
  }

  openAuthBrowser(platform: Parameters<WebNovelMetadataCollectorClient['openAuthBrowser']>[0], signal?: AbortSignal) {
    return this.client().then((client) => client.openAuthBrowser(platform, signal));
  }

  setAuthPlatformEnabled(
    platform: Parameters<WebNovelMetadataCollectorClient['setAuthPlatformEnabled']>[0],
    enabled: boolean,
    signal?: AbortSignal,
  ) {
    return this.client().then((client) => client.setAuthPlatformEnabled(platform, enabled, signal));
  }

  closeAuthBrowser(signal?: AbortSignal) {
    return this.client().then((client) => client.closeAuthBrowser(signal));
  }

  clearAuthSession(signal?: AbortSignal) {
    return this.client().then((client) => client.clearAuthSession(signal));
  }

  authBrowserFrame(afterRevision: number, signal?: AbortSignal) {
    return this.client().then((client) => client.authBrowserFrame(afterRevision, signal));
  }

  authBrowserAction(action: Parameters<WebNovelMetadataCollectorClient['authBrowserAction']>[0], signal?: AbortSignal) {
    return this.client().then((client) => client.authBrowserAction(action, signal));
  }
}
