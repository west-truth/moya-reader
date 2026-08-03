import pg from 'pg';
import { providerSettingsId } from '@noveldesk/text-core/identity/provider';
import type { ProviderModelConfig } from '../../../../src/providers/provider-jobs';
import type { ServerConfig } from '../config.js';
import {
  loadServerAISettings,
  modelIdForProvider,
  providerIsEnabled,
  serverAIProviderIds,
  type ServerAIProviderId,
  type ServerAISettings,
} from './server-ai-config.js';
import { serverTTSProviderIds, type ServerTTSProviderId } from './server-provider-catalog.js';
import { modelIdForTTSProvider } from './server-tts-provider-factory.js';

export type ProviderSettingsScope = 'llm_labeling' | 'tts_synthesis';

export interface ProviderSettings {
  readonly scope: ProviderSettingsScope;
  readonly defaultProviderId?: string;
  readonly enabledProviderIds: string[];
  readonly modelByProvider: Record<string, string>;
  readonly providerOptionsByProvider: Record<string, Record<string, unknown>>;
  readonly updatedAt?: string;
}

export interface ProviderSettingsBundle {
  readonly llmLabeling: ProviderSettings;
  readonly ttsSynthesis: ProviderSettings;
}

interface ProviderSettingsRow {
  scope: ProviderSettingsScope;
  default_provider_id: string | null;
  enabled_provider_ids: unknown;
  model_overrides: unknown;
  provider_options: unknown;
  updated_at: Date | string;
}

interface ProviderSettingsInput {
  readonly scope: ProviderSettingsScope;
  readonly defaultProviderId?: string;
  readonly enabledProviderIds?: string[];
  readonly modelByProvider?: Record<string, string>;
  readonly providerOptionsByProvider?: Record<string, Record<string, unknown>>;
}

type Queryable = Pick<pg.Pool, 'query'>;

const exactSecretKeyNames = new Set([
  'apikey',
  'secret',
  'token',
  'credential',
  'credentials',
  'password',
  'privatekey',
  'clientsecret',
  'authorization',
  'authheader',
  'header',
  'headers',
  'bearer',
  'accesskey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'sessionkey',
  'cookie',
  'endpointurl',
]);
const secretValuePattern =
  /(^sk-(?:proj-)?[A-Za-z0-9_-]{8,}|^AIza[A-Za-z0-9_-]{10,}|^ya29\.|Bearer\s+[A-Za-z0-9._~+/-]+=*|-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key"\s*:|"client_email"\s*:)/i;

export function providerSettingsScope(value: unknown): ProviderSettingsScope | undefined {
  return value === 'llm_labeling' || value === 'tts_synthesis' ? value : undefined;
}

export function hasSecretLikeKey(value: unknown): boolean {
  if (typeof value === 'string') return secretValuePattern.test(value.trim());
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasSecretLikeKey);
  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) => isSecretLikeKey(key) || hasSecretLikeKey(item),
  );
}

export async function loadProviderSettingsBundle(
  pool: Queryable,
  config: ServerConfig,
  env: NodeJS.ProcessEnv = process.env,
  aiSettings: ServerAISettings = loadServerAISettings(env),
): Promise<ProviderSettingsBundle> {
  const result = await pool.query<ProviderSettingsRow>(
    `
      select scope, default_provider_id, enabled_provider_ids, model_overrides, provider_options, updated_at
      from provider_settings
      where user_id = $1
    `,
    [config.defaultUserId],
  );
  const rows = new Map(result.rows.map((row) => [row.scope, row]));
  return {
    llmLabeling: effectiveSettings('llm_labeling', rows.get('llm_labeling'), env, aiSettings),
    ttsSynthesis: effectiveSettings('tts_synthesis', rows.get('tts_synthesis'), env, aiSettings),
  };
}

export async function saveProviderSettings(
  pool: Queryable,
  config: ServerConfig,
  input: ProviderSettingsInput,
  env: NodeJS.ProcessEnv = process.env,
  aiSettings: ServerAISettings = loadServerAISettings(env),
): Promise<ProviderSettings> {
  validateProviderSettingsInput(input);
  const scope = input.scope;
  const allowedProviderIds = allowedProviderIdsForScope(scope);
  const existingResult = await pool.query<ProviderSettingsRow>(
    `
      select scope, default_provider_id, enabled_provider_ids, model_overrides, provider_options, updated_at
      from provider_settings
      where user_id = $1 and scope = $2
    `,
    [config.defaultUserId, scope],
  );
  const existing = existingResult.rows.find((row) => row.scope === scope);
  const hasDefaultProviderId = Object.prototype.hasOwnProperty.call(input, 'defaultProviderId');
  const hasEnabledProviderIds = Object.prototype.hasOwnProperty.call(input, 'enabledProviderIds');
  const hasModelByProvider = Object.prototype.hasOwnProperty.call(input, 'modelByProvider');
  const hasProviderOptionsByProvider = Object.prototype.hasOwnProperty.call(input, 'providerOptionsByProvider');
  const rawEnabledProviderIds = hasEnabledProviderIds
    ? (input.enabledProviderIds ?? [])
    : mapStringArray(existing?.enabled_provider_ids);
  const normalizedEnabledProviderIds = normalizeProviderIds(rawEnabledProviderIds, allowedProviderIds);
  const rawDefaultProviderId = hasDefaultProviderId
    ? input.defaultProviderId
    : (existing?.default_provider_id ?? undefined);
  const defaultProviderId =
    rawDefaultProviderId && allowedProviderIds.has(rawDefaultProviderId) ? rawDefaultProviderId : undefined;
  if (rawDefaultProviderId && !defaultProviderId)
    throw new Error('defaultProviderId is invalid for this provider settings scope');
  const enabledProviderIds =
    defaultProviderId && !normalizedEnabledProviderIds.includes(defaultProviderId)
      ? [...normalizedEnabledProviderIds, defaultProviderId]
      : normalizedEnabledProviderIds;
  const modelByProvider = normalizeModelMap(
    hasModelByProvider
      ? { ...mapStringRecord(existing?.model_overrides), ...input.modelByProvider }
      : mapStringRecord(existing?.model_overrides),
    allowedProviderIds,
  );
  const providerOptionsByProvider = normalizeProviderOptions(
    hasProviderOptionsByProvider
      ? mergeNestedRecords(mapNestedRecord(existing?.provider_options), input.providerOptionsByProvider ?? {})
      : mapNestedRecord(existing?.provider_options),
    allowedProviderIds,
  );
  const result = await pool.query<ProviderSettingsRow>(
    `
      insert into provider_settings (
        id, user_id, scope, default_provider_id, enabled_provider_ids,
        model_overrides, provider_options, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, now(), now())
      on conflict (user_id, scope) do update
        set default_provider_id = excluded.default_provider_id,
            enabled_provider_ids = excluded.enabled_provider_ids,
            model_overrides = excluded.model_overrides,
            provider_options = excluded.provider_options,
            updated_at = now()
      returning scope, default_provider_id, enabled_provider_ids, model_overrides, provider_options, updated_at
    `,
    [
      providerSettingsId(config.defaultUserId, scope),
      config.defaultUserId,
      scope,
      defaultProviderId ?? null,
      JSON.stringify(enabledProviderIds),
      JSON.stringify(modelByProvider),
      JSON.stringify(providerOptionsByProvider),
    ],
  );
  return effectiveSettings(scope, result.rows[0], env, aiSettings);
}

export function providerEnabledBySettings(settings: ProviderSettings, providerId: string): boolean {
  return settings.enabledProviderIds.length === 0 || settings.enabledProviderIds.includes(providerId);
}

export function modelFromSettings(settings: ProviderSettings, providerId: string): string | undefined {
  return settings.modelByProvider[providerId];
}

export function providerOptionsFromSettings(settings: ProviderSettings, providerId: string): Record<string, unknown> {
  return settings.providerOptionsByProvider[providerId] ?? {};
}

function validateProviderSettingsInput(input: ProviderSettingsInput): void {
  if (hasSecretLikeKey(input.providerOptionsByProvider)) {
    throw new Error('providerOptionsByProvider must not contain secret-like keys or values');
  }
  if (input.modelByProvider && hasSecretLikeKey(input.modelByProvider)) {
    throw new Error('modelByProvider must not contain secret-like keys or values');
  }
}

function effectiveSettings(
  scope: ProviderSettingsScope,
  row: ProviderSettingsRow | undefined,
  env: NodeJS.ProcessEnv,
  aiSettings: ServerAISettings,
): ProviderSettings {
  const allowedProviderIds = allowedProviderIdsForScope(scope);
  const envEnabledIds = envEnabledProviderIds(scope, env, aiSettings);
  const rowEnabledIds = normalizeProviderIds(mapStringArray(row?.enabled_provider_ids), allowedProviderIds);
  const enabledProviderIds = rowEnabledIds.length
    ? rowEnabledIds
    : [...envEnabledIds].filter((providerId) => allowedProviderIds.has(providerId));
  const modelByProvider = {
    ...defaultModelByProvider(scope, env, aiSettings),
    ...normalizeModelMap(mapStringRecord(row?.model_overrides), allowedProviderIds),
  };
  const providerOptionsByProvider = normalizeProviderOptions(
    mapNestedRecord(row?.provider_options),
    allowedProviderIds,
  );
  const defaultProviderId = chooseDefaultProviderId(
    scope,
    row?.default_provider_id ?? undefined,
    enabledProviderIds,
    env,
    aiSettings,
  );
  return {
    scope,
    defaultProviderId,
    enabledProviderIds,
    modelByProvider,
    providerOptionsByProvider,
    updatedAt:
      row?.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row?.updated_at
          ? String(row.updated_at)
          : undefined,
  };
}

function chooseDefaultProviderId(
  scope: ProviderSettingsScope,
  storedDefault: string | undefined,
  enabledProviderIds: string[],
  env: NodeJS.ProcessEnv,
  aiSettings: ServerAISettings,
): string | undefined {
  const envDefault =
    scope === 'llm_labeling' ? aiSettings.defaultProviderId : env.TTS_PROVIDER_DEFAULT?.trim() || 'system';
  if (storedDefault && enabledProviderIds.includes(storedDefault)) return storedDefault;
  if (enabledProviderIds.includes(envDefault)) return envDefault;
  return enabledProviderIds[0];
}

function allowedProviderIdsForScope(scope: ProviderSettingsScope): Set<string> {
  return new Set(scope === 'llm_labeling' ? serverAIProviderIds : serverTTSProviderIds);
}

function envEnabledProviderIds(
  scope: ProviderSettingsScope,
  env: NodeJS.ProcessEnv,
  aiSettings: ServerAISettings,
): Set<string> {
  if (scope === 'llm_labeling') {
    return new Set(serverAIProviderIds.filter((providerId) => providerIsEnabled(aiSettings, providerId)));
  }
  const enabled = new Set<string>(['system']);
  for (const providerId of (env.TTS_PROVIDER_ENABLED ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    enabled.add(providerId);
  }
  return enabled;
}

function defaultModelByProvider(
  scope: ProviderSettingsScope,
  env: NodeJS.ProcessEnv,
  aiSettings: ServerAISettings,
): Record<string, string> {
  const entries: ProviderModelConfig[] = [];
  if (scope === 'llm_labeling') {
    for (const providerId of serverAIProviderIds) {
      const modelId = modelIdForProvider(aiSettings, providerId as ServerAIProviderId);
      if (modelId) entries.push({ providerId, modelId, displayName: modelId, purpose: 'labeling', enabled: true });
    }
  } else {
    for (const providerId of serverTTSProviderIds) {
      const modelId = modelIdForTTSProvider(providerId as ServerTTSProviderId, undefined, env);
      if (modelId) entries.push({ providerId, modelId, displayName: modelId, purpose: 'tts', enabled: true });
    }
  }
  return Object.fromEntries(entries.map((entry) => [entry.providerId, entry.modelId]));
}

function normalizeProviderIds(values: string[], allowedProviderIds: Set<string>): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value && allowedProviderIds.has(value)))];
}

function normalizeModelMap(values: Record<string, string>, allowedProviderIds: Set<string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([providerId, modelId]) => [providerId.trim(), String(modelId).trim()])
      .filter(
        ([providerId, modelId]) => allowedProviderIds.has(providerId) && Boolean(modelId) && !hasSecretLikeKey(modelId),
      ),
  );
}

function normalizeProviderOptions(
  values: Record<string, Record<string, unknown>>,
  allowedProviderIds: Set<string>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([providerId, options]) =>
        allowedProviderIds.has(providerId) &&
        options &&
        typeof options === 'object' &&
        !Array.isArray(options) &&
        !hasSecretLikeKey(options),
    ),
  );
}

function isSecretLikeKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    exactSecretKeyNames.has(normalized) ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('password') ||
    normalized.endsWith('credential') ||
    normalized.endsWith('credentials') ||
    normalized.endsWith('privatekey') ||
    normalized.endsWith('clientsecret') ||
    normalized.endsWith('accesskey') ||
    normalized.endsWith('accesstoken') ||
    normalized.endsWith('refreshtoken') ||
    normalized.endsWith('idtoken') ||
    normalized.endsWith('authtoken') ||
    normalized.endsWith('endpointurl') ||
    normalized.startsWith('authorization')
  );
}

function mapStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mapStringRecord(value: unknown): Record<string, string> {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function mapNestedRecord(value: unknown): Record<string, Record<string, unknown>> {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, Record<string, unknown>] =>
      Boolean(entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1])),
    ),
  );
}

function mergeNestedRecords(
  base: Record<string, Record<string, unknown>>,
  patch: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const result = { ...base };
  for (const [providerId, options] of Object.entries(patch)) {
    result[providerId] = { ...options };
  }
  return result;
}
