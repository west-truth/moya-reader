import {
  WEBNOVEL_METADATA_COLLECTOR_DEFAULT_ENDPOINT,
  WebNovelMetadataCollectorClient,
  WebNovelMetadataCollectorError,
  normalizeWebNovelMetadataCollectorEndpoint,
  type WebNovelMetadataCollectorAuthPlatform,
  type WebNovelMetadataCollectorAuthStatus,
  type WebNovelMetadataCollectorBrowserAction,
  type WebNovelMetadataCollectorBrowserFrame,
  type WebNovelMetadataCollectorBatchResolveResult,
  type WebNovelMetadataCollectorCover,
  type WebNovelMetadataCollectorHealth,
  type WebNovelMetadataCollectorResolveInput,
  type WebNovelMetadataCollectorResolveResult,
} from './webnovel-metadata-collector-client';

export const WEBNOVEL_METADATA_COLLECTOR_SETTINGS_SCHEMA_VERSION = 1 as const;
export const WEBNOVEL_METADATA_COLLECTOR_SETTINGS_STORAGE_KEY = 'noveldesk.extension.webNovelMetadataCollector.v1';

export type WebNovelMetadataCollectorAutomaticApply = 'off' | 'missing_fields';

/** Device-local, non-secret settings owned by the bundled enrichment extension. */
export interface WebNovelMetadataCollectorSettings {
  readonly endpoint: string;
  readonly includeAdult: boolean;
  readonly automaticLookup: boolean;
  readonly automaticApply: WebNovelMetadataCollectorAutomaticApply;
}

export interface WebNovelMetadataCollectorSettingsDocumentV1 {
  readonly schemaVersion: typeof WEBNOVEL_METADATA_COLLECTOR_SETTINGS_SCHEMA_VERSION;
  readonly settings: WebNovelMetadataCollectorSettings;
}

export interface SharedWebNovelMetadataCollectorSettingsV1 {
  readonly schemaVersion: 1;
  readonly includeAdult: boolean;
  readonly automaticLookup: boolean;
  readonly automaticApply: WebNovelMetadataCollectorAutomaticApply;
}

export interface WebNovelMetadataCollectorSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type WebNovelMetadataCollectorConnectionState = 'disconnected' | 'checking' | 'connected' | 'unavailable';

export interface WebNovelMetadataCollectorBrokerIssue {
  readonly code: string;
  readonly message: string;
}

export interface WebNovelMetadataCollectorBrokerSnapshot {
  readonly revision: number;
  readonly connectionState: WebNovelMetadataCollectorConnectionState;
  readonly settings: WebNovelMetadataCollectorSettings;
  readonly health?: WebNovelMetadataCollectorHealth;
  readonly auth?: WebNovelMetadataCollectorAuthStatus;
  readonly connectionIssue?: WebNovelMetadataCollectorBrokerIssue;
  readonly authIssue?: WebNovelMetadataCollectorBrokerIssue;
  readonly lastCheckedAt?: string;
}

export interface WebNovelMetadataCollectorClientPort {
  health(signal?: AbortSignal): Promise<WebNovelMetadataCollectorHealth>;
  resolve(
    input: WebNovelMetadataCollectorResolveInput,
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorResolveResult>;
  resolveBatch(
    inputs: readonly WebNovelMetadataCollectorResolveInput[],
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorBatchResolveResult>;
  downloadCover(coverRef: string, signal?: AbortSignal): Promise<WebNovelMetadataCollectorCover>;
  authStatus(signal?: AbortSignal): Promise<WebNovelMetadataCollectorAuthStatus>;
  openAuthBrowser(
    platform: WebNovelMetadataCollectorAuthPlatform,
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorAuthStatus>;
  setAuthPlatformEnabled(
    platform: WebNovelMetadataCollectorAuthPlatform,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorAuthStatus>;
  closeAuthBrowser(signal?: AbortSignal): Promise<WebNovelMetadataCollectorAuthStatus>;
  clearAuthSession(signal?: AbortSignal): Promise<WebNovelMetadataCollectorAuthStatus>;
  authBrowserFrame(
    afterRevision: number,
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorBrowserFrame | undefined>;
  authBrowserAction(action: WebNovelMetadataCollectorBrowserAction, signal?: AbortSignal): Promise<void>;
}

export interface WebNovelMetadataCollectorBrokerOptions {
  readonly storage?: WebNovelMetadataCollectorSettingsStorage | null;
  readonly clientFactory?: (endpoint: string) => WebNovelMetadataCollectorClientPort;
  readonly managedRuntime?: {
    readonly client: WebNovelMetadataCollectorClientPort;
    stop(): Promise<void>;
  };
  readonly now?: () => Date;
}

export interface WebNovelMetadataCollectorAutomaticApplyDecision {
  readonly eligible: boolean;
  readonly mode: WebNovelMetadataCollectorAutomaticApply;
  readonly reasons: readonly (WebNovelMetadataCollectorResolveResult['autoApplyReasons'][number] | 'policy_off')[];
}

const DEFAULT_SETTINGS: WebNovelMetadataCollectorSettings = {
  endpoint: WEBNOVEL_METADATA_COLLECTOR_DEFAULT_ENDPOINT,
  includeAdult: false,
  automaticLookup: false,
  automaticApply: 'off',
};

const MAX_REMEMBERED_COVER_REFS = 256;

function defaultStorage(): WebNovelMetadataCollectorSettingsStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedSettings(value: unknown): WebNovelMetadataCollectorSettings | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.endpoint !== 'string' ||
    typeof value.includeAdult !== 'boolean' ||
    typeof value.automaticLookup !== 'boolean' ||
    (value.automaticApply !== 'off' && value.automaticApply !== 'missing_fields')
  ) {
    return undefined;
  }
  try {
    return {
      endpoint: normalizeWebNovelMetadataCollectorEndpoint(value.endpoint),
      includeAdult: value.includeAdult,
      automaticLookup: value.automaticLookup,
      automaticApply: value.automaticApply,
    };
  } catch {
    return undefined;
  }
}

function parseSettings(raw: string | null): WebNovelMetadataCollectorSettings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const document: unknown = JSON.parse(raw);
    if (!isRecord(document) || document.schemaVersion !== WEBNOVEL_METADATA_COLLECTOR_SETTINGS_SCHEMA_VERSION) {
      return { ...DEFAULT_SETTINGS };
    }
    return normalizedSettings(document.settings) ?? { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function issueFrom(error: unknown): WebNovelMetadataCollectorBrokerIssue {
  if (error instanceof WebNovelMetadataCollectorError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'unexpected_error',
    message: error instanceof Error && error.message.trim() ? error.message : '알 수 없는 오류가 발생했습니다.',
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function settingsDocument(settings: WebNovelMetadataCollectorSettings): WebNovelMetadataCollectorSettingsDocumentV1 {
  return {
    schemaVersion: WEBNOVEL_METADATA_COLLECTOR_SETTINGS_SCHEMA_VERSION,
    settings,
  };
}

export function evaluateWebNovelMetadataCollectorAutomaticApply(
  mode: WebNovelMetadataCollectorAutomaticApply,
  result: WebNovelMetadataCollectorResolveResult,
): WebNovelMetadataCollectorAutomaticApplyDecision {
  if (mode === 'off') return { eligible: false, mode, reasons: ['policy_off', ...result.autoApplyReasons] };
  return { eligible: result.autoApplyEligible, mode, reasons: [...result.autoApplyReasons] };
}

/**
 * Host-owned boundary for the local companion. It persists no account credentials or browser session material.
 */
export class WebNovelMetadataCollectorBroker {
  private readonly storage: WebNovelMetadataCollectorSettingsStorage | null;
  private readonly clientFactory: (endpoint: string) => WebNovelMetadataCollectorClientPort;
  private readonly now: () => Date;
  private readonly managedRuntime?: NonNullable<WebNovelMetadataCollectorBrokerOptions['managedRuntime']>;
  private readonly listeners = new Set<() => void>();
  private readonly coverEndpointByRef = new Map<string, string>();
  private operationRevision = 0;
  private settings: WebNovelMetadataCollectorSettings;
  private snapshot: WebNovelMetadataCollectorBrokerSnapshot;

  constructor(options: WebNovelMetadataCollectorBrokerOptions = {}) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.managedRuntime = options.managedRuntime;
    this.clientFactory =
      options.clientFactory ??
      (options.managedRuntime
        ? () => options.managedRuntime!.client
        : (endpoint) => new WebNovelMetadataCollectorClient(endpoint));
    this.now = options.now ?? (() => new Date());
    this.settings = this.loadSettings();
    this.snapshot = {
      revision: 0,
      connectionState: 'disconnected',
      settings: this.settings,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): WebNovelMetadataCollectorBrokerSnapshot => this.snapshot;

  getSettings(): WebNovelMetadataCollectorSettings {
    return this.settings;
  }

  getSharedSettings(): SharedWebNovelMetadataCollectorSettingsV1 {
    return {
      schemaVersion: 1,
      includeAdult: this.settings.includeAdult,
      automaticLookup: this.settings.automaticLookup,
      automaticApply: this.settings.automaticApply,
    };
  }

  applySharedSettings(settings: SharedWebNovelMetadataCollectorSettingsV1): void {
    this.updateSettings({
      includeAdult: settings.includeAdult,
      automaticLookup: settings.automaticLookup,
      automaticApply: settings.automaticApply,
    });
  }

  get connectionMode(): 'managed' | 'external' {
    return this.managedRuntime ? 'managed' : 'external';
  }

  updateSettings(update: Partial<WebNovelMetadataCollectorSettings>): WebNovelMetadataCollectorSettings {
    const next = normalizedSettings({ ...this.settings, ...update });
    if (!next) throw new Error('웹소설 정보 수집기 설정이 올바르지 않습니다.');
    const endpointChanged = next.endpoint !== this.settings.endpoint;
    this.settings = next;
    this.persistSettings();
    if (endpointChanged) this.operationRevision += 1;
    this.publish({
      settings: next,
      ...(endpointChanged
        ? {
            connectionState: 'disconnected',
            health: undefined,
            auth: undefined,
            connectionIssue: undefined,
            authIssue: undefined,
            lastCheckedAt: undefined,
          }
        : undefined),
    });
    return next;
  }

  resetSettings(): WebNovelMetadataCollectorSettings {
    return this.updateSettings({ ...DEFAULT_SETTINGS });
  }

  async connect(signal?: AbortSignal): Promise<WebNovelMetadataCollectorBrokerSnapshot> {
    const operation = ++this.operationRevision;
    const endpoint = this.settings.endpoint;
    const client = this.clientFactory(endpoint);
    this.publish({
      connectionState: 'checking',
      health: undefined,
      auth: undefined,
      connectionIssue: undefined,
      authIssue: undefined,
    });
    try {
      const health = await client.health(signal);
      let auth: WebNovelMetadataCollectorAuthStatus | undefined;
      let authIssue: WebNovelMetadataCollectorBrokerIssue | undefined;
      if (health.capabilities.adultAuth.available) {
        try {
          auth = await client.authStatus(signal);
        } catch (error) {
          if (isAbortError(error)) throw error;
          authIssue = issueFrom(error);
        }
      }
      if (!this.isCurrent(operation, endpoint)) return this.snapshot;
      this.publish({
        connectionState: 'connected',
        health,
        auth,
        connectionIssue: undefined,
        authIssue,
        lastCheckedAt: this.now().toISOString(),
      });
    } catch (error) {
      if (!this.isCurrent(operation, endpoint)) return this.snapshot;
      if (isAbortError(error)) {
        this.publish({ connectionState: 'disconnected', connectionIssue: undefined });
        throw error;
      }
      this.publish({
        connectionState: 'unavailable',
        health: undefined,
        auth: undefined,
        connectionIssue: issueFrom(error),
        authIssue: undefined,
        lastCheckedAt: this.now().toISOString(),
      });
    }
    return this.snapshot;
  }

  refresh(signal?: AbortSignal): Promise<WebNovelMetadataCollectorBrokerSnapshot> {
    return this.connect(signal);
  }

  disconnect(): void {
    this.operationRevision += 1;
    this.publish({
      connectionState: 'disconnected',
      health: undefined,
      auth: undefined,
      connectionIssue: undefined,
      authIssue: undefined,
      lastCheckedAt: undefined,
    });
  }

  async stopManagedRuntime(): Promise<void> {
    await this.managedRuntime?.stop();
  }

  async resolve(
    input: Omit<WebNovelMetadataCollectorResolveInput, 'includeAdult'> & { readonly includeAdult?: boolean },
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorResolveResult> {
    const result = await this.resolveBatch([input], signal);
    const item = result.results[0];
    if (!item) {
      throw new WebNovelMetadataCollectorError('invalid_response', '웹소설 정보 수집기 응답이 비어 있습니다.');
    }
    return item;
  }

  async resolveBatch(
    inputs: readonly (Omit<WebNovelMetadataCollectorResolveInput, 'includeAdult'> & {
      readonly includeAdult?: boolean;
    })[],
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorBatchResolveResult> {
    const endpoint = this.settings.endpoint;
    const includeAdult = this.settings.includeAdult;
    const result = await this.clientFactory(endpoint).resolveBatch(
      inputs.map((input) => ({ ...input, includeAdult: input.includeAdult ?? includeAdult })),
      signal,
    );
    for (const item of result.results) {
      if (item.coverRef) this.rememberCoverEndpoint(item.coverRef, endpoint);
    }
    return result;
  }

  async downloadCover(coverRef: string, signal?: AbortSignal): Promise<WebNovelMetadataCollectorCover> {
    const endpoint = this.coverEndpointByRef.get(coverRef) ?? this.settings.endpoint;
    try {
      const cover = await this.clientFactory(endpoint).downloadCover(coverRef, signal);
      this.coverEndpointByRef.delete(coverRef);
      return cover;
    } catch (error) {
      if (!isAbortError(error)) this.coverEndpointByRef.delete(coverRef);
      throw error;
    }
  }

  refreshAuthStatus(signal?: AbortSignal): Promise<WebNovelMetadataCollectorAuthStatus> {
    return this.runAuth((client) => client.authStatus(signal));
  }

  openAuthBrowser(
    platform: WebNovelMetadataCollectorAuthPlatform,
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorAuthStatus> {
    return this.runAuth((client) => client.openAuthBrowser(platform, signal));
  }

  setAuthPlatformEnabled(
    platform: WebNovelMetadataCollectorAuthPlatform,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorAuthStatus> {
    return this.runAuth((client) => client.setAuthPlatformEnabled(platform, enabled, signal));
  }

  closeAuthBrowser(signal?: AbortSignal): Promise<WebNovelMetadataCollectorAuthStatus> {
    return this.runAuth((client) => client.closeAuthBrowser(signal));
  }

  clearAuthSession(signal?: AbortSignal): Promise<WebNovelMetadataCollectorAuthStatus> {
    return this.runAuth((client) => client.clearAuthSession(signal));
  }

  authBrowserFrame(
    afterRevision: number,
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorBrowserFrame | undefined> {
    return this.clientFactory(this.settings.endpoint).authBrowserFrame(afterRevision, signal);
  }

  authBrowserAction(action: WebNovelMetadataCollectorBrowserAction, signal?: AbortSignal): Promise<void> {
    return this.clientFactory(this.settings.endpoint).authBrowserAction(action, signal);
  }

  private loadSettings(): WebNovelMetadataCollectorSettings {
    try {
      return parseSettings(this.storage?.getItem(WEBNOVEL_METADATA_COLLECTOR_SETTINGS_STORAGE_KEY) ?? null);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private persistSettings(): void {
    try {
      this.storage?.setItem(
        WEBNOVEL_METADATA_COLLECTOR_SETTINGS_STORAGE_KEY,
        JSON.stringify(settingsDocument(this.settings)),
      );
    } catch {
      // Privacy-restricted and quota-limited browsers retain settings for this app session.
    }
  }

  private publish(update: Partial<WebNovelMetadataCollectorBrokerSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...update,
      revision: this.snapshot.revision + 1,
    };
    for (const listener of this.listeners) listener();
  }

  private isCurrent(operation: number, endpoint: string): boolean {
    return operation === this.operationRevision && endpoint === this.settings.endpoint;
  }

  private rememberCoverEndpoint(coverRef: string, endpoint: string): void {
    this.coverEndpointByRef.delete(coverRef);
    this.coverEndpointByRef.set(coverRef, endpoint);
    while (this.coverEndpointByRef.size > MAX_REMEMBERED_COVER_REFS) {
      const oldest = this.coverEndpointByRef.keys().next().value as string | undefined;
      if (!oldest) break;
      this.coverEndpointByRef.delete(oldest);
    }
  }

  private async runAuth(
    operation: (client: WebNovelMetadataCollectorClientPort) => Promise<WebNovelMetadataCollectorAuthStatus>,
  ): Promise<WebNovelMetadataCollectorAuthStatus> {
    const endpoint = this.settings.endpoint;
    try {
      const auth = await operation(this.clientFactory(endpoint));
      if (endpoint === this.settings.endpoint) this.publish({ auth, authIssue: undefined });
      return auth;
    } catch (error) {
      if (!isAbortError(error) && endpoint === this.settings.endpoint) {
        this.publish({ authIssue: issueFrom(error) });
      }
      throw error;
    }
  }
}
