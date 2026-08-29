export const DEFAULT_SUWAYOMI_BASE_URL = 'http://127.0.0.1:4567';

const PUBLIC_RUNTIME_CONFIG_SCHEMA_VERSION = 1;
const MAX_PUBLIC_IDENTIFIER_LENGTH = 4_096;

type PublicRuntimeConfigKey =
  | 'dropboxAppKey'
  | 'dropboxSourceAppKey'
  | 'googleDriveClientId'
  | 'googleDriveAppId'
  | 'googleDriveDeveloperKey'
  | 'suwayomiDefaultUrl';

export interface AppPublicRuntimeConfig {
  readonly dropbox: {
    readonly appKey?: string;
    readonly sourceAppKey?: string;
  };
  readonly googleDrive: {
    readonly clientId?: string;
    readonly appId?: string;
    readonly developerKey?: string;
  };
  readonly suwayomi: {
    readonly defaultBaseUrl: string;
  };
}

export interface PublicBuildTimeConfig {
  readonly VITE_DROPBOX_APP_KEY?: unknown;
  readonly VITE_DROPBOX_SOURCE_APP_KEY?: unknown;
  readonly VITE_GOOGLE_DRIVE_CLIENT_ID?: unknown;
  readonly VITE_GOOGLE_DRIVE_APP_ID?: unknown;
  readonly VITE_GOOGLE_DRIVE_DEVELOPER_KEY?: unknown;
  readonly VITE_SUWAYOMI_DEFAULT_URL?: unknown;
}

function runtimeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === PUBLIC_RUNTIME_CONFIG_SCHEMA_VERSION ? record : undefined;
}

function publicIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_PUBLIC_IDENTIFIER_LENGTH) return undefined;
  return normalized;
}

function layeredPublicIdentifier(
  runtime: Record<string, unknown> | undefined,
  runtimeKey: PublicRuntimeConfigKey,
  buildValue: unknown,
): string | undefined {
  // A container-generated key is authoritative even when it is intentionally empty.
  if (runtime && Object.prototype.hasOwnProperty.call(runtime, runtimeKey)) {
    return publicIdentifier(runtime[runtimeKey]);
  }
  return publicIdentifier(buildValue);
}

function httpBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * The only browser-visible deployment configuration boundary. Unknown fields are ignored so
 * server credentials can never become public merely by being present in the container environment.
 */
export function resolveAppPublicRuntimeConfig(
  runtimeValue: unknown,
  build: PublicBuildTimeConfig,
): AppPublicRuntimeConfig {
  const runtime = runtimeRecord(runtimeValue);
  const dropbox = Object.freeze({
    appKey: layeredPublicIdentifier(runtime, 'dropboxAppKey', build.VITE_DROPBOX_APP_KEY),
    sourceAppKey: layeredPublicIdentifier(runtime, 'dropboxSourceAppKey', build.VITE_DROPBOX_SOURCE_APP_KEY),
  });
  const googleDrive = Object.freeze({
    clientId: layeredPublicIdentifier(runtime, 'googleDriveClientId', build.VITE_GOOGLE_DRIVE_CLIENT_ID),
    appId: layeredPublicIdentifier(runtime, 'googleDriveAppId', build.VITE_GOOGLE_DRIVE_APP_ID),
    developerKey: layeredPublicIdentifier(runtime, 'googleDriveDeveloperKey', build.VITE_GOOGLE_DRIVE_DEVELOPER_KEY),
  });
  const configuredSuwayomiUrl = layeredPublicIdentifier(runtime, 'suwayomiDefaultUrl', build.VITE_SUWAYOMI_DEFAULT_URL);
  const suwayomi = Object.freeze({
    defaultBaseUrl: httpBaseUrl(configuredSuwayomiUrl) ?? DEFAULT_SUWAYOMI_BASE_URL,
  });
  return Object.freeze({ dropbox, googleDrive, suwayomi });
}

const injectedRuntimeConfig = (globalThis as typeof globalThis & { readonly __MOYA_RUNTIME_CONFIG__?: unknown })
  .__MOYA_RUNTIME_CONFIG__;

const buildTimeConfig: PublicBuildTimeConfig = {
  VITE_DROPBOX_APP_KEY: import.meta.env.VITE_DROPBOX_APP_KEY,
  VITE_DROPBOX_SOURCE_APP_KEY: import.meta.env.VITE_DROPBOX_SOURCE_APP_KEY,
  VITE_GOOGLE_DRIVE_CLIENT_ID: import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID,
  VITE_GOOGLE_DRIVE_APP_ID: import.meta.env.VITE_GOOGLE_DRIVE_APP_ID,
  VITE_GOOGLE_DRIVE_DEVELOPER_KEY: import.meta.env.VITE_GOOGLE_DRIVE_DEVELOPER_KEY,
  VITE_SUWAYOMI_DEFAULT_URL: import.meta.env.VITE_SUWAYOMI_DEFAULT_URL,
};

export const appPublicRuntimeConfig = resolveAppPublicRuntimeConfig(injectedRuntimeConfig, buildTimeConfig);
