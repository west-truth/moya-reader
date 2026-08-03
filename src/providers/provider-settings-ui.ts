import type { ProviderCatalogItem, ProviderOptionConfig } from './provider-jobs';
import type { RemoteProviderSettings } from '../services/remote/remote-api-client';

type JsonRecord = Record<string, unknown>;

export interface ProviderSettingsDraft {
  readonly scope: RemoteProviderSettings['scope'];
  readonly defaultProviderId: string;
  readonly enabledProviderIds: string[];
  readonly selectedProviderId: string;
  readonly modelByProvider: Record<string, string>;
  readonly providerOptionsTextByProvider: Record<string, string>;
}

export type ProviderSettingsSaveInput = Partial<Omit<RemoteProviderSettings, 'scope' | 'updatedAt'>>;

export interface ProviderSettingsBuildResult {
  readonly ok: boolean;
  readonly input?: ProviderSettingsSaveInput;
  readonly message?: string;
  readonly providerId?: string;
}

export interface ProviderDraftOptionsBuildResult {
  readonly ok: boolean;
  readonly options?: JsonRecord;
  readonly message?: string;
  readonly providerId?: string;
}

export type ProviderOptionDraftValue = string | number | boolean | undefined;

const secretKeyPattern = /(api.?key|secret|token|credential|password|private.?key|authorization|bearer|client.?secret|access.?key|refresh.?token|endpoint.?url)/i;
const secretValuePattern = /(^sk-(?:proj-)?[A-Za-z0-9_-]{8,}|^AIza[A-Za-z0-9_-]{10,}|^ya29\.|Bearer\s+[A-Za-z0-9._~+/-]+=*|-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key"\s*:|"client_email"\s*:)/i;

export function catalogProviderReady(provider: ProviderCatalogItem): boolean {
  if (!provider.implemented || !provider.enabled) return false;
  return provider.secretPolicy === 'no_secret_required' || provider.secretConfigured;
}

export function providerReadinessLabel(provider: ProviderCatalogItem): string {
  if (!provider.implemented) return '미구현';
  if (!provider.enabled) return '서버 비활성';
  if (provider.secretPolicy !== 'no_secret_required' && !provider.secretConfigured) {
    return provider.executionTarget === 'desktop_secure_local' ? '키 설정 필요' : '서버 설정 필요';
  }
  return '사용 가능';
}

export function createProviderSettingsDraft(
  settings: RemoteProviderSettings,
  providers: ProviderCatalogItem[],
): ProviderSettingsDraft {
  const providerIds = providers.map((provider) => provider.providerId);
  const fallbackProviderId = settings.defaultProviderId && providerIds.includes(settings.defaultProviderId)
    ? settings.defaultProviderId
    : providers.find(catalogProviderReady)?.providerId ?? providerIds[0] ?? '';
  const enabledProviderIds = settings.enabledProviderIds.filter((providerId) => providerIds.includes(providerId));
  return {
    scope: settings.scope,
    defaultProviderId: fallbackProviderId,
    enabledProviderIds: enabledProviderIds.length ? enabledProviderIds : fallbackProviderId ? [fallbackProviderId] : [],
    selectedProviderId: fallbackProviderId,
    modelByProvider: Object.fromEntries(providers.map((provider) => [
      provider.providerId,
      settings.modelByProvider[provider.providerId] ?? provider.models.find((model) => model.enabled)?.modelId ?? '',
    ])),
    providerOptionsTextByProvider: Object.fromEntries(providers.map((provider) => [
      provider.providerId,
      stringifyProviderOptions(settings.providerOptionsByProvider[provider.providerId]),
    ])),
  };
}

export function setDraftProviderEnabled(
  draft: ProviderSettingsDraft,
  providerId: string,
  enabled: boolean,
): ProviderSettingsDraft {
  const nextEnabled = enabled
    ? [...new Set([...draft.enabledProviderIds, providerId])]
    : draft.enabledProviderIds.filter((item) => item !== providerId);
  const nextDefault = nextEnabled.includes(draft.defaultProviderId)
    ? draft.defaultProviderId
    : nextEnabled[0] ?? '';
  return {
    ...draft,
    defaultProviderId: nextDefault,
    selectedProviderId: draft.selectedProviderId === providerId && !enabled ? nextDefault : draft.selectedProviderId,
    enabledProviderIds: nextEnabled,
  };
}

export function setDraftDefaultProvider(
  draft: ProviderSettingsDraft,
  providerId: string,
): ProviderSettingsDraft {
  return {
    ...draft,
    defaultProviderId: providerId,
    selectedProviderId: providerId,
    enabledProviderIds: [...new Set([...draft.enabledProviderIds, providerId])],
  };
}

export function requestProfileIdForDraftProvider(
  draft: ProviderSettingsDraft,
  provider: ProviderCatalogItem,
): string {
  const profiles = provider.capabilities.supportedRequestProfiles ?? [];
  const fallback = profiles.find((profile) => profile.enabled)?.profileId ?? '';
  const options = parseProviderOptionsText(draft.providerOptionsTextByProvider[provider.providerId]);
  const value = options && typeof options.requestProfileId === 'string' ? options.requestProfileId.trim() : '';
  return value || fallback;
}

export function autoRepairForDraftProvider(
  draft: ProviderSettingsDraft,
  providerId: string,
): boolean {
  const options = parseProviderOptionsText(draft.providerOptionsTextByProvider[providerId]);
  return options?.autoRepairOnValidationFailure === true;
}

export function setDraftProviderRequestProfile(
  draft: ProviderSettingsDraft,
  providerId: string,
  requestProfileId: string,
): ProviderSettingsDraft {
  const options = parseProviderOptionsText(draft.providerOptionsTextByProvider[providerId]) ?? {};
  if (requestProfileId.trim()) {
    options.requestProfileId = requestProfileId.trim();
  } else {
    delete options.requestProfileId;
  }
  return {
    ...draft,
    providerOptionsTextByProvider: {
      ...draft.providerOptionsTextByProvider,
      [providerId]: stringifyProviderOptions(options),
    },
  };
}

export function setDraftProviderAutoRepair(
  draft: ProviderSettingsDraft,
  providerId: string,
  enabled: boolean,
): ProviderSettingsDraft {
  const options = parseProviderOptionsText(draft.providerOptionsTextByProvider[providerId]) ?? {};
  if (enabled) {
    options.autoRepairOnValidationFailure = true;
  } else {
    delete options.autoRepairOnValidationFailure;
  }
  return {
    ...draft,
    providerOptionsTextByProvider: {
      ...draft.providerOptionsTextByProvider,
      [providerId]: stringifyProviderOptions(options),
    },
  };
}

export function providerSettingOptionConfigs(provider: ProviderCatalogItem): ProviderOptionConfig[] {
  const optionsByKey = new Map<string, ProviderOptionConfig>();
  for (const option of [
    ...(provider.capabilities.supportedRenderOptions ?? []),
    ...(provider.capabilities.supportedProviderOptions ?? []),
  ]) {
    if (option.placements && !option.placements.includes('provider_settings')) continue;
    if (!optionsByKey.has(option.optionKey)) optionsByKey.set(option.optionKey, option);
  }
  return [...optionsByKey.values()];
}

export function providerVoiceProfileOptionConfigs(provider: ProviderCatalogItem): ProviderOptionConfig[] {
  const optionsByKey = new Map<string, ProviderOptionConfig>();
  for (const option of provider.capabilities.supportedProviderOptions ?? []) {
    if (!option.placements?.includes('voice_profile')) continue;
    if (option.optionKey === 'voice') continue;
    if (!optionsByKey.has(option.optionKey)) optionsByKey.set(option.optionKey, option);
  }
  return [...optionsByKey.values()];
}

export function providerOptionValueForDraftProvider(
  draft: ProviderSettingsDraft,
  providerId: string,
  optionKey: string,
): ProviderOptionDraftValue {
  const options = parseProviderOptionsText(draft.providerOptionsTextByProvider[providerId]);
  return providerOptionValueFromRecord(options, optionKey);
}

export function providerOptionValueFromRecord(
  options: Record<string, unknown> | undefined,
  optionKey: string,
): ProviderOptionDraftValue {
  const value = options?.[optionKey];
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined;
}

export function setDraftProviderOption(
  draft: ProviderSettingsDraft,
  providerId: string,
  option: Pick<ProviderOptionConfig, 'optionKey' | 'valueType'>,
  value: ProviderOptionDraftValue,
): ProviderSettingsDraft {
  const options = parseProviderOptionsText(draft.providerOptionsTextByProvider[providerId]) ?? {};
  const nextOptions = setProviderOptionInRecord(options, option, value);
  return {
    ...draft,
    providerOptionsTextByProvider: {
      ...draft.providerOptionsTextByProvider,
      [providerId]: stringifyProviderOptions(nextOptions),
    },
  };
}

export function setProviderOptionInRecord(
  options: Record<string, unknown> | undefined,
  option: Pick<ProviderOptionConfig, 'optionKey' | 'valueType'>,
  value: ProviderOptionDraftValue,
): Record<string, unknown> {
  const nextOptions: Record<string, unknown> = isPlainRecord(options) ? { ...options } : {};
  const normalizedValue = normalizeProviderOptionValue(option, value);
  if (normalizedValue === undefined) {
    delete nextOptions[option.optionKey];
  } else {
    nextOptions[option.optionKey] = normalizedValue;
  }
  return nextOptions;
}

export function providerOptionsContainSecretLikeValue(value: unknown): boolean {
  return hasSecretLikeKeyOrValue(value);
}

export function buildProviderSettingsSaveInput(
  draft: ProviderSettingsDraft,
  providers: ProviderCatalogItem[],
): ProviderSettingsBuildResult {
  const providerIds = new Set(providers.map((provider) => provider.providerId));
  const defaultProviderId = draft.defaultProviderId.trim();
  if (defaultProviderId && !providerIds.has(defaultProviderId)) {
    return { ok: false, message: '기본 provider가 catalog에 없습니다.', providerId: defaultProviderId };
  }

  const providerOptionsByProvider: Record<string, JsonRecord> = {};
  for (const provider of providers) {
    const providerId = provider.providerId;
    const text = draft.providerOptionsTextByProvider[providerId]?.trim();
    if (!text) {
      providerOptionsByProvider[providerId] = {};
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, message: 'Provider 옵션 JSON 형식이 올바르지 않습니다.', providerId };
    }
    if (!isPlainRecord(parsed)) {
      return { ok: false, message: 'Provider 옵션은 JSON object여야 합니다.', providerId };
    }
    if (hasSecretLikeKeyOrValue(parsed)) {
      return { ok: false, message: 'Provider 옵션에는 API key, token, credential 값을 저장할 수 없습니다.', providerId };
    }
    providerOptionsByProvider[providerId] = parsed;
  }

  return {
    ok: true,
    input: {
      defaultProviderId: defaultProviderId || undefined,
      enabledProviderIds: draft.enabledProviderIds.filter((providerId) => providerIds.has(providerId)),
      modelByProvider: Object.fromEntries(Object.entries(draft.modelByProvider)
        .filter(([providerId]) => providerIds.has(providerId))
        .map(([providerId, modelId]) => [providerId, modelId.trim()])
        .filter(([, modelId]) => Boolean(modelId))),
      providerOptionsByProvider,
    },
  };
}

export function buildProviderDraftOptionsForProvider(
  draft: ProviderSettingsDraft,
  providerId: string,
): ProviderDraftOptionsBuildResult {
  const text = draft.providerOptionsTextByProvider[providerId]?.trim();
  if (!text) return { ok: true, options: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: 'Provider 옵션 JSON 형식이 올바르지 않습니다.', providerId };
  }
  if (!isPlainRecord(parsed)) {
    return { ok: false, message: 'Provider 옵션은 JSON object여야 합니다.', providerId };
  }
  if (hasSecretLikeKeyOrValue(parsed)) {
    return { ok: false, message: 'Provider 옵션에는 API key, token, credential 값을 저장할 수 없습니다.', providerId };
  }
  return { ok: true, options: parsed };
}

function stringifyProviderOptions(value: JsonRecord | undefined): string {
  if (!value || Object.keys(value).length === 0) return '';
  return JSON.stringify(value, null, 2);
}

function parseProviderOptionsText(text: string | undefined): JsonRecord | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeProviderOptionValue(
  option: Pick<ProviderOptionConfig, 'optionKey' | 'valueType'>,
  value: ProviderOptionDraftValue,
): ProviderOptionDraftValue {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  if (option.valueType === 'boolean') return value === true || value === 'true';
  if (option.valueType === 'number') {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function isPlainRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasSecretLikeKeyOrValue(value: unknown): boolean {
  if (typeof value === 'string') return secretValuePattern.test(value.trim());
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasSecretLikeKeyOrValue);
  return Object.entries(value as JsonRecord)
    .some(([key, item]) => secretKeyPattern.test(key) || hasSecretLikeKeyOrValue(item));
}
