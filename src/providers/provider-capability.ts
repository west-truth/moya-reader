import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { ProviderExecutionMetadata } from './provider-execution';

export const PROVIDER_CAPABILITY_CONTRACT_VERSION = 'provider-capability-v1' as const;
export const PROVIDER_ADMISSION_POLICY_VERSION = 'provider-admission-v1' as const;

export type ProviderCapabilitySource = 'live_discovery' | 'catalog' | 'user_override' | 'conservative_default';
export type ProviderCapabilityFreshness = 'verified' | 'unverified' | 'stale';

interface ProviderCapabilitySnapshotBase {
  readonly id: string;
  readonly version: typeof PROVIDER_CAPABILITY_CONTRACT_VERSION;
  readonly providerId: string;
  readonly requestedModelId: string;
  readonly resolvedModelVersion?: string;
  readonly adapterVersion: string;
  readonly source: ProviderCapabilitySource;
  readonly freshness: ProviderCapabilityFreshness;
  readonly verifiedAt: string;
  readonly expiresAt?: string;
  readonly fingerprint: string;
}

export interface LLMCapabilitySnapshot extends ProviderCapabilitySnapshotBase {
  readonly kind: 'llm';
  readonly schemaDialect: string;
  readonly structuredOutputMode: 'none' | 'json' | 'json_schema';
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly countStrategy: 'provider_api' | 'adapter_estimator' | 'conservative_default';
  readonly estimatedCharactersPerToken: number;
  readonly safetyFactor: number;
}

export interface TTSCapabilitySnapshot extends ProviderCapabilitySnapshotBase {
  readonly kind: 'tts';
  readonly maxTextCharacters?: number;
  readonly maxTextBytes?: number;
  readonly maxPromptBytes?: number;
  readonly maxInputTokens?: number;
  readonly maxDurationMs?: number;
  readonly maxInputSegments?: number;
  readonly formats: readonly string[];
  readonly streaming: boolean;
  readonly timingMarks: 'none' | 'word' | 'segment';
  readonly supportedControls: readonly string[];
  readonly voiceCatalogFingerprint?: string;
}

export type ProviderCapabilitySnapshot = LLMCapabilitySnapshot | TTSCapabilitySnapshot;

export type ProviderTaskKind =
  | 'graph_observation'
  | 'graph_consolidation'
  | 'standard_labeling'
  | 'speaker_attribution'
  | 'ambiguous_escalation'
  | 'patch_repair'
  | 'prosody_projection'
  | 'tts_synthesis';

export interface ProviderTaskProfileSnapshot {
  readonly id: string;
  readonly version: 'provider-task-profile-v1';
  readonly taskKind: ProviderTaskKind;
  readonly requestProfileId: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly providerId: string;
  readonly requestedModelId: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly escalationSignals: readonly string[];
  readonly automaticEscalation: boolean;
  readonly fingerprint: string;
}

export interface ProviderAdmissionComponent {
  readonly key: string;
  readonly characters: number;
  readonly required: boolean;
}

export interface ProviderAdmissionSnapshot {
  readonly id: string;
  readonly version: typeof PROVIDER_ADMISSION_POLICY_VERSION;
  readonly capabilitySnapshotId: string;
  readonly taskProfileId: string;
  readonly estimateMethod: LLMCapabilitySnapshot['countStrategy'];
  readonly inputCharacters: number;
  readonly estimatedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly availableInputTokens: number;
  readonly decision: 'accepted' | 'rejected';
  readonly components: readonly ProviderAdmissionComponent[];
  readonly shrinkTrace: readonly string[];
  readonly fingerprint: string;
}

export interface ProviderUsageEstimateComparison {
  readonly capabilitySnapshotId: string;
  readonly admissionSnapshotId: string;
  readonly estimatedInputTokens: number;
  readonly actualInputTokens?: number;
  readonly inputTokenDelta?: number;
  readonly inputTokenRatio?: number;
  readonly outputTokenReserve: number;
  readonly actualOutputTokens?: number;
  readonly resolvedModelVersion?: string;
  readonly modelVersionDrift: boolean;
}

export interface ConfidenceCalibrationBucket {
  readonly minInclusive: number;
  readonly maxInclusive: number;
  readonly calibratedCorrectness: number;
  readonly sampleCount: number;
}

export interface ConfidenceCalibrationProfile {
  readonly id: string;
  readonly providerId: string;
  readonly requestedModelId: string;
  readonly resolvedModelVersion?: string;
  readonly taskProfileId: string;
  readonly corpusFingerprint: string;
  readonly buckets: readonly ConfidenceCalibrationBucket[];
  readonly minimumSamples: number;
  readonly createdAt: string;
}

export interface ConfidenceRiskProjection {
  readonly risk: 'low' | 'medium' | 'high';
  readonly calibratedCorrectness?: number;
  readonly displayMode: 'calibrated_probability' | 'risk_bucket';
  readonly deterministicSignals: readonly string[];
}

function numberOption(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function integerOption(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return Math.floor(numberOption(value, fallback, minimum, maximum));
}

function stringList(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const values = value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim());
  return values.length > 0 ? [...new Set(values)] : [...fallback];
}

function isoTime(value: string | Date | undefined): string {
  return (value ? new Date(value) : new Date()).toISOString();
}

function capabilityVerifiedAt(source: ProviderCapabilitySource, value: string | Date | undefined): string {
  if (value) return isoTime(value);
  return source === 'live_discovery' || source === 'catalog' ? isoTime(undefined) : '1970-01-01T00:00:00.000Z';
}

function expiryTime(verifiedAt: string, ttlMs: number | undefined): string | undefined {
  return ttlMs && ttlMs > 0 ? new Date(new Date(verifiedAt).getTime() + ttlMs).toISOString() : undefined;
}

function structuredOutputMode(
  providerId: string,
): Pick<LLMCapabilitySnapshot, 'schemaDialect' | 'structuredOutputMode'> {
  if (providerId === 'mock') return { schemaDialect: 'noveldesk-json-schema', structuredOutputMode: 'json_schema' };
  if (providerId === 'openai') return { schemaDialect: 'openai-json-schema', structuredOutputMode: 'json_schema' };
  if (providerId.startsWith('gemini')) return { schemaDialect: 'gemini-schema', structuredOutputMode: 'json_schema' };
  if (providerId === 'anthropic')
    return { schemaDialect: 'anthropic-tool-schema', structuredOutputMode: 'json_schema' };
  return { schemaDialect: 'json', structuredOutputMode: 'json' };
}

export function resolveLLMCapabilitySnapshot(input: {
  readonly providerId: string;
  readonly modelId?: string;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
  readonly resolvedModelVersion?: string;
  readonly adapterVersion?: string;
  readonly source?: ProviderCapabilitySource;
  readonly verifiedAt?: string | Date;
  readonly ttlMs?: number;
}): LLMCapabilitySnapshot {
  const options = input.providerOptions ?? {};
  const requestedModelId = input.modelId?.trim() || 'provider-default';
  const hasOverride = options.contextWindowTokens !== undefined || options.maxOutputTokens !== undefined;
  const source = input.source ?? (hasOverride ? 'user_override' : 'conservative_default');
  const maxContextTokens = integerOption(options.contextWindowTokens, 32_768, 2_048, 2_000_000);
  const maxOutputTokens = Math.min(
    integerOption(options.maxOutputTokens, 8_192, 256, 131_072),
    Math.max(1, maxContextTokens - 1),
  );
  const estimatedCharactersPerToken = numberOption(options.estimatedCharactersPerToken, 1.5, 0.5, 8);
  const safetyFactor = numberOption(options.contextSafetyFactor, 0.9, 0.5, 1);
  const verifiedAt = capabilityVerifiedAt(source, input.verifiedAt);
  const core = {
    kind: 'llm' as const,
    version: PROVIDER_CAPABILITY_CONTRACT_VERSION,
    providerId: input.providerId,
    requestedModelId,
    resolvedModelVersion: input.resolvedModelVersion,
    adapterVersion: input.adapterVersion ?? 'provider-adapter-v1',
    source,
    freshness: source === 'live_discovery' || source === 'catalog' ? ('verified' as const) : ('unverified' as const),
    verifiedAt,
    expiresAt: expiryTime(verifiedAt, input.ttlMs),
    ...structuredOutputMode(input.providerId),
    maxContextTokens,
    maxOutputTokens,
    countStrategy:
      source === 'conservative_default' ? ('conservative_default' as const) : ('adapter_estimator' as const),
    estimatedCharactersPerToken,
    safetyFactor,
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('llm_capability_snapshot', [input.providerId, requestedModelId, fingerprint]),
    fingerprint,
  };
}

export function resolveTTSCapabilitySnapshot(input: {
  readonly providerId: string;
  readonly modelId?: string;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
  readonly resolvedModelVersion?: string;
  readonly adapterVersion?: string;
  readonly source?: ProviderCapabilitySource;
  readonly verifiedAt?: string | Date;
  readonly ttlMs?: number;
  readonly voiceCatalogFingerprint?: string;
}): TTSCapabilitySnapshot {
  const options = input.providerOptions ?? {};
  const requestedModelId = input.modelId?.trim() || 'provider-default';
  const hasOverride = options.maxInputCharacters !== undefined || options.maxInputSegments !== undefined;
  const source = input.source ?? (hasOverride ? 'user_override' : 'conservative_default');
  const maxTextCharacters = integerOption(options.maxInputCharacters, 4_000, 1, 1_000_000);
  const verifiedAt = capabilityVerifiedAt(source, input.verifiedAt);
  const timingMarks: TTSCapabilitySnapshot['timingMarks'] =
    options.timingMarks === 'word' || options.timingMarks === 'segment' ? options.timingMarks : 'none';
  const core = {
    kind: 'tts' as const,
    version: PROVIDER_CAPABILITY_CONTRACT_VERSION,
    providerId: input.providerId,
    requestedModelId,
    resolvedModelVersion: input.resolvedModelVersion,
    adapterVersion: input.adapterVersion ?? 'tts-adapter-v1',
    source,
    freshness: source === 'live_discovery' || source === 'catalog' ? ('verified' as const) : ('unverified' as const),
    verifiedAt,
    expiresAt: expiryTime(verifiedAt, input.ttlMs),
    maxTextCharacters,
    maxTextBytes: integerOption(options.maxTextBytes, maxTextCharacters * 4, 1, 8_000_000),
    maxPromptBytes:
      options.maxPromptBytes === undefined ? undefined : integerOption(options.maxPromptBytes, 4_096, 1, 1_000_000),
    maxInputTokens:
      options.maxInputTokens === undefined ? undefined : integerOption(options.maxInputTokens, 8_192, 1, 2_000_000),
    maxDurationMs:
      options.maxDurationMs === undefined ? undefined : integerOption(options.maxDurationMs, 600_000, 1, 86_400_000),
    maxInputSegments: integerOption(options.maxInputSegments, 12, 1, 10_000),
    formats: stringList(options.formats, ['mp3']),
    streaming: options.streaming === true,
    timingMarks,
    supportedControls: stringList(options.supportedControls, ['voice', 'speed']),
    voiceCatalogFingerprint: input.voiceCatalogFingerprint,
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('tts_capability_snapshot', [input.providerId, requestedModelId, fingerprint]),
    fingerprint,
  };
}

function taskKindForJob(jobType: string): ProviderTaskKind {
  if (jobType === 'character_bundle_analysis') return 'graph_observation';
  if (jobType === 'character_graph_merge') return 'graph_consolidation';
  if (jobType === 'chapter_label_repair') return 'patch_repair';
  if (jobType === 'speaker_attribution_v3') return 'speaker_attribution';
  if (jobType === 'speaker_attribution_escalation_v1') return 'ambiguous_escalation';
  if (jobType === 'tts_synthesis' || jobType === 'tts_prefetch') return 'tts_synthesis';
  return 'standard_labeling';
}

export function resolveProviderTaskProfile(input: {
  readonly jobType: string;
  readonly requestProfile: { readonly id: string; readonly promptVersion: string; readonly schemaVersion: string };
  readonly providerId: string;
  readonly modelId?: string;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}): ProviderTaskProfileSnapshot {
  const options = input.providerOptions ?? {};
  const taskKind = taskKindForJob(input.jobType);
  const requestedModelId = input.modelId?.trim() || 'provider-default';
  const core = {
    version: 'provider-task-profile-v1' as const,
    taskKind,
    requestProfileId: input.requestProfile.id,
    promptVersion: input.requestProfile.promptVersion,
    schemaVersion: input.requestProfile.schemaVersion,
    providerId: input.providerId,
    requestedModelId,
    timeoutMs: integerOption(options.requestTimeoutMs, taskKind === 'tts_synthesis' ? 120_000 : 90_000, 1_000, 900_000),
    maxRetries: integerOption(
      options.maxProviderRetries,
      taskKind === 'patch_repair' || taskKind === 'speaker_attribution' ? 0 : 1,
      0,
      5,
    ),
    escalationSignals: [
      'deterministic_validator_issue',
      'omitted_character_surface_match',
      'graph_contradiction',
      'calibrated_ambiguity',
      'repeated_repair',
      'user_cost_cap',
    ],
    automaticEscalation: options.automaticModelEscalation === true,
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('provider_task_profile', [input.providerId, requestedModelId, fingerprint]),
    fingerprint,
  };
}

export function buildProviderAdmissionSnapshot(input: {
  readonly capability: LLMCapabilitySnapshot;
  readonly taskProfile: ProviderTaskProfileSnapshot;
  readonly components: readonly ProviderAdmissionComponent[];
  readonly shrinkTrace?: readonly string[];
  readonly estimatedInputTokens?: number;
  readonly reservedOutputTokens?: number;
}): ProviderAdmissionSnapshot {
  const inputCharacters = input.components.reduce((sum, component) => sum + Math.max(0, component.characters), 0);
  const estimatedInputTokens =
    input.estimatedInputTokens ?? Math.ceil(inputCharacters / input.capability.estimatedCharactersPerToken);
  const reservedOutputTokens = Math.min(
    input.capability.maxOutputTokens,
    Math.max(1, Math.floor(input.reservedOutputTokens ?? input.capability.maxOutputTokens)),
  );
  const availableInputTokens = Math.max(
    1,
    Math.floor(input.capability.maxContextTokens * input.capability.safetyFactor) - reservedOutputTokens,
  );
  const core = {
    version: PROVIDER_ADMISSION_POLICY_VERSION,
    capabilitySnapshotId: input.capability.id,
    taskProfileId: input.taskProfile.id,
    estimateMethod: input.capability.countStrategy,
    inputCharacters,
    estimatedInputTokens,
    reservedOutputTokens,
    availableInputTokens,
    decision: estimatedInputTokens <= availableInputTokens ? ('accepted' as const) : ('rejected' as const),
    components: input.components,
    shrinkTrace: input.shrinkTrace ?? [],
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('provider_admission_snapshot', [input.capability.id, input.taskProfile.id, fingerprint]),
    fingerprint,
  };
}

export function compareProviderUsageEstimate(
  capability: ProviderCapabilitySnapshot,
  admission: ProviderAdmissionSnapshot,
  execution: ProviderExecutionMetadata | undefined,
): ProviderUsageEstimateComparison {
  const actualInputTokens = execution?.inputTokens;
  return {
    capabilitySnapshotId: capability.id,
    admissionSnapshotId: admission.id,
    estimatedInputTokens: admission.estimatedInputTokens,
    actualInputTokens,
    inputTokenDelta: actualInputTokens === undefined ? undefined : actualInputTokens - admission.estimatedInputTokens,
    inputTokenRatio:
      actualInputTokens === undefined || admission.estimatedInputTokens <= 0
        ? undefined
        : actualInputTokens / admission.estimatedInputTokens,
    outputTokenReserve: admission.reservedOutputTokens,
    actualOutputTokens: execution?.outputTokens,
    resolvedModelVersion: execution?.resolvedModelVersion,
    modelVersionDrift: Boolean(
      capability.resolvedModelVersion &&
      execution?.resolvedModelVersion &&
      capability.resolvedModelVersion !== execution.resolvedModelVersion,
    ),
  };
}

export function calibrationProfileApplies(input: {
  readonly calibration: ConfidenceCalibrationProfile;
  readonly providerId: string;
  readonly requestedModelId: string;
  readonly resolvedModelVersion?: string;
  readonly taskProfileId: string;
  readonly corpusFingerprint: string;
}): boolean {
  return (
    input.calibration.providerId === input.providerId &&
    input.calibration.requestedModelId === input.requestedModelId &&
    input.calibration.resolvedModelVersion === input.resolvedModelVersion &&
    input.calibration.taskProfileId === input.taskProfileId &&
    input.calibration.corpusFingerprint === input.corpusFingerprint
  );
}

export function projectConfidenceRisk(input: {
  readonly rawConfidence: number;
  readonly deterministicSignals?: readonly string[];
  readonly calibration?: ConfidenceCalibrationProfile;
}): ConfidenceRiskProjection {
  const confidence = Math.min(1, Math.max(0, input.rawConfidence));
  const signals = [...new Set(input.deterministicSignals ?? [])];
  const bucket = input.calibration?.buckets.find(
    (item) =>
      confidence >= item.minInclusive &&
      confidence <= item.maxInclusive &&
      item.sampleCount >= input.calibration!.minimumSamples,
  );
  const correctness = bucket?.calibratedCorrectness;
  const baseRisk =
    correctness === undefined
      ? confidence >= 0.85
        ? 'low'
        : confidence >= 0.6
          ? 'medium'
          : 'high'
      : correctness >= 0.9
        ? 'low'
        : correctness >= 0.7
          ? 'medium'
          : 'high';
  const risk = signals.length > 0 && baseRisk === 'low' ? 'medium' : signals.length > 1 ? 'high' : baseRisk;
  return {
    risk,
    calibratedCorrectness: correctness,
    displayMode: correctness === undefined ? 'risk_bucket' : 'calibrated_probability',
    deterministicSignals: signals,
  };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

export function parseProviderCapabilitySnapshot(value: unknown): ProviderCapabilitySnapshot {
  const body = objectValue(value, 'provider capability snapshot');
  if (body.version !== PROVIDER_CAPABILITY_CONTRACT_VERSION) throw new Error('provider capability version is invalid');
  const common = {
    id: requiredText(body.id, 'capability id'),
    version: PROVIDER_CAPABILITY_CONTRACT_VERSION,
    providerId: requiredText(body.providerId, 'capability providerId'),
    requestedModelId: requiredText(body.requestedModelId, 'capability requestedModelId'),
    resolvedModelVersion: typeof body.resolvedModelVersion === 'string' ? body.resolvedModelVersion : undefined,
    adapterVersion: requiredText(body.adapterVersion, 'capability adapterVersion'),
    source: body.source as ProviderCapabilitySource,
    freshness: body.freshness as ProviderCapabilityFreshness,
    verifiedAt: new Date(requiredText(body.verifiedAt, 'capability verifiedAt')).toISOString(),
    expiresAt: typeof body.expiresAt === 'string' ? new Date(body.expiresAt).toISOString() : undefined,
    fingerprint: requiredText(body.fingerprint, 'capability fingerprint'),
  };
  if (!['live_discovery', 'catalog', 'user_override', 'conservative_default'].includes(common.source)) {
    throw new Error('provider capability source is invalid');
  }
  if (!['verified', 'unverified', 'stale'].includes(common.freshness)) {
    throw new Error('provider capability freshness is invalid');
  }
  if (body.kind === 'llm') {
    if (!['none', 'json', 'json_schema'].includes(String(body.structuredOutputMode))) {
      throw new Error('LLM structured output mode is invalid');
    }
    if (!['provider_api', 'adapter_estimator', 'conservative_default'].includes(String(body.countStrategy))) {
      throw new Error('LLM count strategy is invalid');
    }
    return {
      ...common,
      kind: 'llm',
      schemaDialect: requiredText(body.schemaDialect, 'LLM schema dialect'),
      structuredOutputMode: body.structuredOutputMode as LLMCapabilitySnapshot['structuredOutputMode'],
      maxContextTokens: requiredNumber(body.maxContextTokens, 'LLM max context tokens'),
      maxOutputTokens: requiredNumber(body.maxOutputTokens, 'LLM max output tokens'),
      countStrategy: body.countStrategy as LLMCapabilitySnapshot['countStrategy'],
      estimatedCharactersPerToken: requiredNumber(body.estimatedCharactersPerToken, 'LLM character estimate'),
      safetyFactor: requiredNumber(body.safetyFactor, 'LLM safety factor'),
    };
  }
  if (body.kind !== 'tts') throw new Error('provider capability kind is invalid');
  if (!Array.isArray(body.formats) || !Array.isArray(body.supportedControls)) {
    throw new Error('TTS capability arrays are invalid');
  }
  if (!['none', 'word', 'segment'].includes(String(body.timingMarks))) throw new Error('TTS timing marks are invalid');
  const optionalNumber = (key: string) =>
    body[key] === undefined ? undefined : requiredNumber(body[key], `TTS ${key}`);
  return {
    ...common,
    kind: 'tts',
    maxTextCharacters: optionalNumber('maxTextCharacters'),
    maxTextBytes: optionalNumber('maxTextBytes'),
    maxPromptBytes: optionalNumber('maxPromptBytes'),
    maxInputTokens: optionalNumber('maxInputTokens'),
    maxDurationMs: optionalNumber('maxDurationMs'),
    maxInputSegments: optionalNumber('maxInputSegments'),
    formats: body.formats.map((item) => requiredText(item, 'TTS format')),
    streaming: body.streaming === true,
    timingMarks: body.timingMarks as TTSCapabilitySnapshot['timingMarks'],
    supportedControls: body.supportedControls.map((item) => requiredText(item, 'TTS control')),
    voiceCatalogFingerprint:
      typeof body.voiceCatalogFingerprint === 'string' ? body.voiceCatalogFingerprint : undefined,
  };
}

export function parseProviderTaskProfileSnapshot(value: unknown): ProviderTaskProfileSnapshot {
  const body = objectValue(value, 'provider task profile');
  if (body.version !== 'provider-task-profile-v1') throw new Error('provider task profile version is invalid');
  if (!Array.isArray(body.escalationSignals)) throw new Error('provider task escalation signals are invalid');
  return {
    id: requiredText(body.id, 'task profile id'),
    version: 'provider-task-profile-v1',
    taskKind: requiredText(body.taskKind, 'task kind') as ProviderTaskKind,
    requestProfileId: requiredText(body.requestProfileId, 'task request profile'),
    promptVersion: requiredText(body.promptVersion, 'task prompt version'),
    schemaVersion: requiredText(body.schemaVersion, 'task schema version'),
    providerId: requiredText(body.providerId, 'task providerId'),
    requestedModelId: requiredText(body.requestedModelId, 'task modelId'),
    timeoutMs: requiredNumber(body.timeoutMs, 'task timeout'),
    maxRetries: requiredNumber(body.maxRetries, 'task max retries'),
    escalationSignals: body.escalationSignals.map((item) => requiredText(item, 'task escalation signal')),
    automaticEscalation: body.automaticEscalation === true,
    fingerprint: requiredText(body.fingerprint, 'task fingerprint'),
  };
}

export function parseProviderAdmissionSnapshot(value: unknown): ProviderAdmissionSnapshot {
  const body = objectValue(value, 'provider admission snapshot');
  if (body.version !== PROVIDER_ADMISSION_POLICY_VERSION) throw new Error('provider admission version is invalid');
  if (!Array.isArray(body.components) || !Array.isArray(body.shrinkTrace)) {
    throw new Error('provider admission arrays are invalid');
  }
  if (body.decision !== 'accepted' && body.decision !== 'rejected')
    throw new Error('provider admission decision is invalid');
  return {
    id: requiredText(body.id, 'admission id'),
    version: PROVIDER_ADMISSION_POLICY_VERSION,
    capabilitySnapshotId: requiredText(body.capabilitySnapshotId, 'admission capability id'),
    taskProfileId: requiredText(body.taskProfileId, 'admission task profile id'),
    estimateMethod: body.estimateMethod as ProviderAdmissionSnapshot['estimateMethod'],
    inputCharacters: requiredNumber(body.inputCharacters, 'admission input characters'),
    estimatedInputTokens: requiredNumber(body.estimatedInputTokens, 'admission estimated input'),
    reservedOutputTokens: requiredNumber(body.reservedOutputTokens, 'admission output reserve'),
    availableInputTokens: requiredNumber(body.availableInputTokens, 'admission available input'),
    decision: body.decision,
    components: body.components.map((item) => {
      const component = objectValue(item, 'admission component');
      return {
        key: requiredText(component.key, 'admission component key'),
        characters: requiredNumber(component.characters, 'admission component characters'),
        required: component.required === true,
      };
    }),
    shrinkTrace: body.shrinkTrace.map((item) => requiredText(item, 'admission shrink trace')),
    fingerprint: requiredText(body.fingerprint, 'admission fingerprint'),
  };
}

export function providerCapabilityFreshnessAt(
  snapshot: ProviderCapabilitySnapshot,
  at: string | Date = new Date(),
): ProviderCapabilityFreshness {
  if (snapshot.expiresAt && new Date(snapshot.expiresAt).getTime() <= new Date(at).getTime()) return 'stale';
  return snapshot.freshness;
}
