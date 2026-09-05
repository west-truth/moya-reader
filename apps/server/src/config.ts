import path from 'node:path';

export type ServerExposure = 'loopback' | 'external';

export interface ProviderJobAdmissionLimits {
  /** Maximum queued/running attempts. Zero explicitly disables this limit. */
  maxActiveAttempts: number;
  /** Maximum admitted attempts in a rolling 60-second window. Zero disables this limit. */
  maxAttemptsPerMinute: number;
  /** Maximum admitted attempts during one UTC calendar day. Zero disables this limit. */
  maxAttemptsPerUtcDay: number;
}

export const DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS: Readonly<ProviderJobAdmissionLimits> = Object.freeze({
  maxActiveAttempts: 4,
  maxAttemptsPerMinute: 60,
  maxAttemptsPerUtcDay: 1_000,
});

const defaultLocalCorsOrigins = [
  'http://127.0.0.1:1421',
  'http://localhost:1421',
  'http://127.0.0.1:8080',
  'http://localhost:8080',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
] as const;

export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  dataDir: string;
  maxChunkBytes: number;
  maxUploadBytes: number;
  staleUploadMaxAgeMs: number;
  runMigrationsOnStart: boolean;
  defaultUserId: string;
  providerJobAdmission?: ProviderJobAdmissionLimits;
  authToken?: string;
  /** Number of immediate reverse-proxy hops allowed to supply X-Forwarded-For. Zero disables trust. */
  trustedProxyHops?: number;
  exposure?: ServerExposure;
  corsAllowedOrigins?: readonly string[];
  webNovelMetadataCollectorUrl?: string;
  webNovelMetadataCollectorRemoteAuthEnabled?: boolean;
  textSourceServerUrl?: string;
  textSourceServerKey?: string;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
}

function optionalInternalHttpUrlFromEnv(value: string | undefined, key: string): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`${key} must be an HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${key} must be an HTTP(S) URL without credentials, query strings, or fragments`);
  }
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return url.toString().replace(/\/$/u, '');
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function nonNegativeIntegerFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${key} must be a safe non-negative integer`);
  return parsed;
}

function positiveIntegerFromEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = nonNegativeIntegerFromEnv(env, key, fallback);
  if (parsed <= 0 || parsed > maximum) {
    throw new Error(`${key} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

function boundedNonNegativeIntegerFromEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  maximum: number,
): number {
  const parsed = nonNegativeIntegerFromEnv(env, key, fallback);
  if (parsed > maximum) throw new Error(`${key} must be no greater than ${maximum}`);
  return parsed;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.').map((part) => Number(part));
  return (
    octets.length === 4 &&
    octets[0] === 127 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
  );
}

function exposureFromEnv(env: NodeJS.ProcessEnv, host: string): ServerExposure {
  const configured = env.SERVER_EXPOSURE?.trim().toLowerCase();
  if (configured !== undefined && configured !== 'loopback' && configured !== 'external') {
    throw new Error('SERVER_EXPOSURE must be either loopback or external');
  }
  if (configured) return configured;
  if (env.NODE_ENV?.trim().toLowerCase() === 'production') return 'external';
  return isLoopbackHost(host) ? 'loopback' : 'external';
}

function normalizeCorsOrigin(value: string): string {
  const candidate = value.trim();
  if (!candidate || candidate === '*' || candidate.toLowerCase() === 'null') {
    throw new Error('CORS_ALLOWED_ORIGINS must contain explicit web origins and must not use * or null');
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('CORS_ALLOWED_ORIGINS must contain valid origins');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'tauri:') ||
    url.username ||
    url.password ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'CORS_ALLOWED_ORIGINS must contain origins without credentials, paths, query strings, or fragments',
    );
  }
  return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin;
}

function corsOriginsFromEnv(env: NodeJS.ProcessEnv): readonly string[] {
  const configured = env.CORS_ALLOWED_ORIGINS ?? env.CORS_ORIGIN;
  if (configured === undefined) return defaultLocalCorsOrigins;
  const origins = configured.split(',').map(normalizeCorsOrigin);
  return [...new Set(origins)];
}

function databaseUrlFromEnv(env: NodeJS.ProcessEnv): string {
  const explicit = env.DATABASE_URL?.trim();
  if (explicit) return explicit;
  const hasPgFields = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'].some((key) => env[key] !== undefined);
  if (!hasPgFields) return 'postgres://noveldesk:noveldesk@127.0.0.1:5432/noveldesk';
  const port = positiveIntegerFromEnv(env, 'PGPORT', 5432, 65_535);
  const url = new URL('postgres://localhost');
  url.hostname = env.PGHOST?.trim() || '127.0.0.1';
  url.port = String(port);
  url.username = env.PGUSER ?? 'noveldesk';
  url.password = env.PGPASSWORD ?? 'noveldesk';
  url.pathname = `/${encodeURIComponent(env.PGDATABASE ?? 'noveldesk')}`;
  return url.toString();
}

export function serverExposure(config: ServerConfig): ServerExposure {
  return config.exposure ?? (isLoopbackHost(config.host) ? 'loopback' : 'external');
}

export function corsAllowedOrigins(config: ServerConfig): readonly string[] {
  const origins = config.corsAllowedOrigins ?? defaultLocalCorsOrigins;
  return [...new Set(origins.map(normalizeCorsOrigin))];
}

export function providerJobAdmissionLimits(config: ServerConfig): ProviderJobAdmissionLimits {
  return { ...(config.providerJobAdmission ?? DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS) };
}

export function assertSecureServerConfig(config: ServerConfig): void {
  corsAllowedOrigins(config);
  if (serverExposure(config) === 'external' && !config.authToken?.trim()) {
    throw new Error('READER_AUTH_TOKEN is required when SERVER_EXPOSURE is external');
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.HOST ?? '127.0.0.1';
  return {
    host,
    port: positiveIntegerFromEnv(env, 'PORT', 8787, 65_535),
    databaseUrl: databaseUrlFromEnv(env),
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    dataDir: path.resolve(env.SERVER_DATA_DIR ?? '.server-data'),
    maxChunkBytes: positiveIntegerFromEnv(env, 'MAX_CHUNK_BYTES', 16 * 1024 * 1024),
    maxUploadBytes: positiveIntegerFromEnv(env, 'MAX_UPLOAD_BYTES', 500 * 1024 * 1024),
    staleUploadMaxAgeMs: nonNegativeIntegerFromEnv(env, 'STALE_UPLOAD_MAX_AGE_MS', 7 * 24 * 60 * 60 * 1000),
    runMigrationsOnStart: boolFromEnv(env.RUN_MIGRATIONS_ON_START, true),
    defaultUserId: env.DEFAULT_USER_ID ?? 'user_dev',
    providerJobAdmission: {
      maxActiveAttempts: nonNegativeIntegerFromEnv(
        env,
        'PROVIDER_MAX_ACTIVE_ATTEMPTS',
        DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS.maxActiveAttempts,
      ),
      maxAttemptsPerMinute: nonNegativeIntegerFromEnv(
        env,
        'PROVIDER_MAX_ATTEMPTS_PER_MINUTE',
        DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS.maxAttemptsPerMinute,
      ),
      maxAttemptsPerUtcDay: nonNegativeIntegerFromEnv(
        env,
        'PROVIDER_MAX_ATTEMPTS_PER_UTC_DAY',
        DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS.maxAttemptsPerUtcDay,
      ),
    },
    authToken: env.READER_AUTH_TOKEN?.trim() || env.API_AUTH_TOKEN?.trim() || undefined,
    trustedProxyHops: boundedNonNegativeIntegerFromEnv(env, 'TRUSTED_PROXY_HOPS', 0, 4),
    exposure: exposureFromEnv(env, host),
    corsAllowedOrigins: corsOriginsFromEnv(env),
    textSourceServerUrl: optionalInternalHttpUrlFromEnv(env.TEXT_SOURCE_SERVER_URL, 'TEXT_SOURCE_SERVER_URL'),
    textSourceServerKey: env.TEXT_SOURCE_SERVER_KEY?.trim() || undefined,
    webNovelMetadataCollectorUrl: optionalInternalHttpUrlFromEnv(
      env.WEBNOVEL_METADATA_COLLECTOR_URL,
      'WEBNOVEL_METADATA_COLLECTOR_URL',
    ),
    webNovelMetadataCollectorRemoteAuthEnabled: boolFromEnv(env.WEBNOVEL_METADATA_COLLECTOR_REMOTE_AUTH_ENABLED, false),
    s3: {
      endpoint: env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
      region: env.S3_REGION ?? 'us-east-1',
      bucket: env.S3_BUCKET ?? 'noveldesk-uploads',
      accessKeyId: env.S3_ACCESS_KEY_ID ?? 'minio',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? 'minio-password',
      forcePathStyle: boolFromEnv(env.S3_FORCE_PATH_STYLE, true),
    },
  };
}
