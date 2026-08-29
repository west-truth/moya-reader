import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { providerSecretId } from '@noveldesk/text-core/identity/provider';
import type {
  ProviderCatalogItem,
  ProviderSecretStatus,
  ProviderSettingsScope,
} from '../../../../src/providers/provider-jobs';
import type { ServerConfig } from '../config.js';
import type { ServerProviderCatalog } from './server-provider-catalog.js';
import { serverAIProviderTransportRegistry } from './server-ai-provider-factory.js';
import { serverTTSProviderTransportRegistry } from './server-tts-provider-factory.js';

export type ProviderSecretName = 'api_key' | 'access_token' | 'credential_path' | 'endpoint_url';

export interface ProviderSecretRow {
  readonly scope: ProviderSettingsScope;
  readonly provider_id: string;
  readonly secret_name: ProviderSecretName;
  readonly ciphertext: string;
  readonly iv: string;
  readonly auth_tag: string;
  readonly key_version: string;
  readonly fingerprint: string;
  readonly last4: string | null;
  readonly updated_at: Date | string;
}

export interface ProviderSecretSaveInput {
  readonly scope: ProviderSettingsScope;
  readonly providerId: string;
  readonly secretName?: ProviderSecretName;
  readonly secretValue: string;
}

export interface ResolvedProviderSecrets {
  readonly apiKey?: string;
  readonly accessToken?: string;
  readonly credentialsPath?: string;
  readonly endpointUrl?: string;
}

type Queryable = Pick<pg.Pool, 'query'>;

const keyVersion = 'local-aes-256-gcm-v1';

export function defaultProviderSecretName(
  scope: ProviderSettingsScope,
  providerId: string,
): ProviderSecretName | undefined {
  return scope === 'llm_labeling'
    ? serverAIProviderTransportRegistry.get(providerId)?.secretName
    : serverTTSProviderTransportRegistry.get(providerId)?.secretName;
}

export function providerSupportsUserSecret(
  scope: ProviderSettingsScope,
  providerId: string,
  secretName?: string,
): boolean {
  const expected = defaultProviderSecretName(scope, providerId);
  return Boolean(expected && (!secretName || secretName === expected));
}

export async function saveProviderSecret(
  pool: Queryable,
  config: ServerConfig,
  input: ProviderSecretSaveInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderSecretStatus> {
  const secretName = input.secretName ?? defaultProviderSecretName(input.scope, input.providerId);
  if (!secretName || !providerSupportsUserSecret(input.scope, input.providerId, secretName)) {
    throw new Error('provider secret is not supported for this provider');
  }
  const secretValue = input.secretValue.trim();
  if (!secretValue) throw new Error('provider secret value is required');
  const key = loadProviderSecretMasterKey(config, env);
  const encrypted = encryptProviderSecret(
    key,
    secretValue,
    secretAad(config.defaultUserId, input.scope, input.providerId, secretName),
  );
  const fingerprint = secretFingerprint(secretValue);
  const last4 = secretStatusExposesValueHint(secretName) ? secretValue.slice(-4) : null;
  const result = await pool.query<ProviderSecretRow>(
    `
      insert into provider_secrets (
        id, user_id, scope, provider_id, secret_name, ciphertext, iv, auth_tag,
        key_version, fingerprint, last4, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())
      on conflict (user_id, scope, provider_id, secret_name) do update
        set ciphertext = excluded.ciphertext,
            iv = excluded.iv,
            auth_tag = excluded.auth_tag,
            key_version = excluded.key_version,
            fingerprint = excluded.fingerprint,
            last4 = excluded.last4,
            updated_at = now()
      returning scope, provider_id, secret_name, ciphertext, iv, auth_tag,
                key_version, fingerprint, last4, updated_at
    `,
    [
      providerSecretId({
        userId: config.defaultUserId,
        scope: input.scope,
        providerId: input.providerId,
        secretName,
      }),
      config.defaultUserId,
      input.scope,
      input.providerId,
      secretName,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
      keyVersion,
      fingerprint,
      last4,
    ],
  );
  return userSecretStatusFromRow(result.rows[0]);
}

export async function deleteProviderSecret(
  pool: Queryable,
  config: ServerConfig,
  scope: ProviderSettingsScope,
  providerId: string,
  secretName: ProviderSecretName = defaultProviderSecretName(scope, providerId) ?? 'api_key',
): Promise<void> {
  if (!providerSupportsUserSecret(scope, providerId, secretName)) {
    throw new Error('provider secret is not supported for this provider');
  }
  await pool.query(
    `
      delete from provider_secrets
      where user_id = $1 and scope = $2 and provider_id = $3 and secret_name = $4
    `,
    [config.defaultUserId, scope, providerId, secretName],
  );
}

export async function buildProviderSecretStatuses(
  pool: Queryable,
  config: ServerConfig,
  catalog: ServerProviderCatalog,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderSecretStatus[]> {
  const userRows = await loadUserProviderSecretRows(pool, config).catch(() => []);
  const userByKey = new Map(userRows.map((row) => [statusKey(row.scope, row.provider_id, row.secret_name), row]));
  const providers: Array<{ scope: ProviderSettingsScope; provider: ProviderCatalogItem }> = [
    ...catalog.aiProviders.map((provider) => ({ scope: 'llm_labeling' as const, provider })),
    ...catalog.ttsProviders.map((provider) => ({ scope: 'tts_synthesis' as const, provider })),
  ];
  const statuses: ProviderSecretStatus[] = [];
  for (const item of providers) {
    const secretName = defaultProviderSecretName(item.scope, item.provider.providerId);
    if (!secretName) continue;
    const userRow = userByKey.get(statusKey(item.scope, item.provider.providerId, secretName));
    if (userRow) {
      statuses.push(userSecretStatusFromRow(userRow));
      continue;
    }
    const envSecret = envProviderSecretValue(item.scope, item.provider.providerId, secretName, env);
    if (envSecret) {
      statuses.push({
        scope: item.scope,
        providerId: item.provider.providerId,
        secretName,
        configured: true,
        source: 'env',
        last4: secretStatusExposesValueHint(secretName) ? envSecret.slice(-4) : undefined,
        fingerprint: secretStatusExposesValueHint(secretName) ? secretFingerprint(envSecret) : undefined,
      });
      continue;
    }
    statuses.push({
      scope: item.scope,
      providerId: item.provider.providerId,
      secretName,
      configured: item.provider.secretConfigured,
      source: item.provider.secretConfigured ? 'env' : undefined,
    });
  }
  return statuses;
}

export function applyProviderSecretStatusesToCatalog(
  catalog: ServerProviderCatalog,
  statuses: ProviderSecretStatus[],
): ServerProviderCatalog {
  const byKey = new Map(
    statuses.map((status) => [statusKey(status.scope, status.providerId, status.secretName), status]),
  );
  const apply = (scope: ProviderSettingsScope, provider: ProviderCatalogItem): ProviderCatalogItem => {
    const secretName = defaultProviderSecretName(scope, provider.providerId);
    const status = secretName ? byKey.get(statusKey(scope, provider.providerId, secretName)) : undefined;
    if (!status) return provider;
    return {
      ...provider,
      enabled: provider.enabled || status.configured,
      secretConfigured: provider.secretConfigured || status.configured,
      secretPolicy: status.source === 'user_encrypted' ? 'server_encrypted_store' : provider.secretPolicy,
      secretStatus: status,
    };
  };
  return {
    aiProviders: catalog.aiProviders.map((provider) => apply('llm_labeling', provider)),
    ttsProviders: catalog.ttsProviders.map((provider) => apply('tts_synthesis', provider)),
  };
}

export async function providerSecretStatusBundle(
  pool: Queryable,
  config: ServerConfig,
  catalog: ServerProviderCatalog,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ catalog: ServerProviderCatalog; secretStatuses: ProviderSecretStatus[] }> {
  const secretStatuses = await buildProviderSecretStatuses(pool, config, catalog, env);
  return {
    catalog: applyProviderSecretStatusesToCatalog(catalog, secretStatuses),
    secretStatuses,
  };
}

export async function resolveProviderSecrets(
  pool: Queryable,
  config: ServerConfig,
  scope: ProviderSettingsScope,
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedProviderSecrets> {
  const secretName = defaultProviderSecretName(scope, providerId);
  if (!secretName) return {};
  const userRow = await loadUserProviderSecretRow(pool, config, scope, providerId, secretName);
  const value = userRow
    ? decryptProviderSecret(
        loadProviderSecretMasterKey(config, env),
        userRow,
        secretAad(config.defaultUserId, scope, providerId, secretName),
      )
    : envProviderSecretValue(scope, providerId, secretName, env);
  if (!value) return {};
  if (secretName === 'api_key') return { apiKey: value };
  if (secretName === 'access_token') return { accessToken: value };
  if (secretName === 'credential_path') return { credentialsPath: value };
  if (secretName === 'endpoint_url') return { endpointUrl: value };
  return {};
}

async function loadUserProviderSecretRows(pool: Queryable, config: ServerConfig): Promise<ProviderSecretRow[]> {
  const result = await pool.query<ProviderSecretRow>(
    `
      select scope, provider_id, secret_name, ciphertext, iv, auth_tag,
             key_version, fingerprint, last4, updated_at
      from provider_secrets
      where user_id = $1
    `,
    [config.defaultUserId],
  );
  return result.rows;
}

async function loadUserProviderSecretRow(
  pool: Queryable,
  config: ServerConfig,
  scope: ProviderSettingsScope,
  providerId: string,
  secretName: ProviderSecretName,
): Promise<ProviderSecretRow | undefined> {
  const result = await pool.query<ProviderSecretRow>(
    `
      select scope, provider_id, secret_name, ciphertext, iv, auth_tag,
             key_version, fingerprint, last4, updated_at
      from provider_secrets
      where user_id = $1 and scope = $2 and provider_id = $3 and secret_name = $4
    `,
    [config.defaultUserId, scope, providerId, secretName],
  );
  return result.rows[0];
}

function envProviderSecretValue(
  scope: ProviderSettingsScope,
  providerId: string,
  secretName: ProviderSecretName,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = (candidate?: string) => candidate?.trim() || undefined;
  if (scope === 'llm_labeling') {
    if (providerId === 'openai' && secretName === 'api_key') return value(env.OPENAI_API_KEY);
    if (providerId === 'gemini-ai-studio' && secretName === 'api_key')
      return value(env.GEMINI_API_KEY) ?? value(env.GOOGLE_API_KEY);
    if (providerId === 'anthropic' && secretName === 'api_key') return value(env.ANTHROPIC_API_KEY);
    if (
      (providerId === 'gemini-vertex' || providerId === 'gemini-agent-platform') &&
      secretName === 'credential_path'
    ) {
      return value(env.GOOGLE_APPLICATION_CREDENTIALS);
    }
  }
  if (scope === 'tts_synthesis') {
    if (providerId === 'openai-tts' && secretName === 'api_key') return value(env.OPENAI_API_KEY);
    if (providerId === 'elevenlabs' && secretName === 'api_key') return value(env.ELEVENLABS_API_KEY);
    if (providerId === 'gemini-tts' && secretName === 'api_key')
      return value(env.GEMINI_API_KEY) ?? value(env.GOOGLE_API_KEY);
    if (providerId === 'gemini-vertex-tts' && secretName === 'credential_path')
      return value(env.GOOGLE_APPLICATION_CREDENTIALS);
    if (providerId === 'google-cloud-tts' && secretName === 'access_token') {
      return value(env.TTS_GOOGLE_CLOUD_ACCESS_TOKEN) ?? value(env.GOOGLE_CLOUD_ACCESS_TOKEN);
    }
    if (providerId === 'local-endpoint' && secretName === 'endpoint_url') return value(env.TTS_LOCAL_ENDPOINT_URL);
  }
  return undefined;
}

function userSecretStatusFromRow(row: ProviderSecretRow): ProviderSecretStatus {
  const exposeValueHint = secretStatusExposesValueHint(row.secret_name);
  return {
    scope: row.scope,
    providerId: row.provider_id,
    secretName: row.secret_name,
    configured: true,
    source: 'user_encrypted',
    last4: exposeValueHint ? (row.last4 ?? undefined) : undefined,
    fingerprint: exposeValueHint ? row.fingerprint : undefined,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function secretStatusExposesValueHint(secretName: ProviderSecretName): boolean {
  return secretName !== 'credential_path' && secretName !== 'endpoint_url';
}

function loadProviderSecretMasterKey(config: ServerConfig, env: NodeJS.ProcessEnv): Buffer {
  const explicit = env.PROVIDER_SECRET_ENCRYPTION_KEY?.trim();
  if (explicit) return normalizeMasterKey(explicit);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const keyPath = path.join(config.dataDir, 'provider-secret-key');
  try {
    return normalizeMasterKey(fs.readFileSync(keyPath, 'utf8').trim());
  } catch {
    const key = crypto.randomBytes(32).toString('base64');
    try {
      fs.writeFileSync(keyPath, `${key}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch {
      return normalizeMasterKey(fs.readFileSync(keyPath, 'utf8').trim());
    }
    return normalizeMasterKey(key);
  }
}

function normalizeMasterKey(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.byteLength === 32) return decoded;
  return crypto.createHash('sha256').update(trimmed).digest();
}

function encryptProviderSecret(
  key: Buffer,
  value: string,
  aad: string,
): { ciphertext: string; iv: string; authTag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptProviderSecret(key: Buffer, row: ProviderSecretRow, aad: string): string {
  if (row.key_version !== keyVersion) throw new Error(`Unsupported provider secret key version: ${row.key_version}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

function secretFingerprint(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function secretAad(userId: string, scope: ProviderSettingsScope, providerId: string, secretName: string): string {
  return `${userId}:${scope}:${providerId}:${secretName}`;
}

function statusKey(scope: ProviderSettingsScope, providerId: string, secretName: string): string {
  return `${scope}:${providerId}:${secretName}`;
}
