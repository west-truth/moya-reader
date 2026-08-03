import type { TTSRenderSpec } from './tts-render-spec';
import type { ProviderCapabilitySnapshot } from './provider-capability';

export type ProviderExecutionTarget =
  'browser_local' | 'desktop_secure_local' | 'server_worker' | 'external_local_endpoint';

export type ProviderSecretPolicy =
  | 'no_secret_required'
  | 'server_env_only'
  | 'server_encrypted_store'
  | 'desktop_secure_store_only'
  | 'external_local_endpoint_only';

export type ProviderSecretSource = 'env' | 'user_encrypted' | 'desktop_secure_store' | 'android_secure_store';

export type ProviderSettingsScope = 'llm_labeling' | 'tts_synthesis';

export interface ProviderSecretStatus {
  readonly scope: ProviderSettingsScope;
  readonly providerId: string;
  readonly secretName: string;
  readonly configured: boolean;
  readonly source?: ProviderSecretSource;
  readonly last4?: string;
  readonly fingerprint?: string;
  readonly updatedAt?: string;
}

export type ProviderJobType =
  | 'character_bundle_analysis'
  | 'character_graph_merge'
  | 'chapter_segment_labeling'
  | 'speaker_attribution_v3'
  | 'speaker_attribution_escalation_v1'
  | 'speaker_boundary_patch_v1'
  | 'chapter_label_validation'
  | 'chapter_label_repair'
  | 'tts_synthesis'
  | 'tts_prefetch';

export type ProviderJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type ProviderOutcomeState =
  | 'not_dispatched'
  | 'claimed'
  | 'dispatching'
  | 'in_flight'
  | 'reconciling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown'
  | 'quarantined';

export type ProviderBillingState = 'not_started' | 'not_billable' | 'estimated' | 'billed_possible' | 'confirmed';

export interface ProviderAttemptStatus {
  readonly attemptId: string;
  readonly generation: number;
  readonly outcomeState: ProviderOutcomeState;
  readonly billingState: ProviderBillingState;
  readonly heartbeatAt?: string;
  readonly dispatchStartedAt?: string;
  readonly reconcileAfter?: string;
  readonly normalizedCompletionCode?: string;
  readonly normalizedErrorCode?: string;
}

export interface ProviderCapability {
  readonly providerId: string;
  readonly kind: 'llm' | 'tts' | 'system_tts' | 'local_tts';
  readonly executionTarget: ProviderExecutionTarget;
  readonly secretPolicy: ProviderSecretPolicy;
  readonly supportsStructuredOutput?: boolean;
  readonly supportsStreaming?: boolean;
  readonly supportsAudioCache?: boolean;
  readonly supportsPerCharacterVoice?: boolean;
  readonly supportedRequestProfiles?: ProviderRequestProfileConfig[];
  readonly supportedRenderOptions?: ProviderOptionConfig[];
  readonly supportedProviderOptions?: ProviderOptionConfig[];
  readonly allowsCustomProviderOptions?: boolean;
}

export interface ProviderCatalogItem {
  readonly providerId: string;
  readonly displayName: string;
  readonly kind: ProviderCapability['kind'];
  readonly executionTarget: ProviderExecutionTarget;
  readonly secretPolicy: ProviderSecretPolicy;
  readonly implemented: boolean;
  readonly enabled: boolean;
  readonly secretConfigured: boolean;
  readonly secretStatus?: ProviderSecretStatus;
  readonly models: ProviderModelConfig[];
  readonly capabilities: Omit<ProviderCapability, 'providerId' | 'kind' | 'executionTarget' | 'secretPolicy'>;
}

export interface ProviderModelConfig {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly purpose: 'labeling' | 'validation' | 'repair' | 'tts' | 'fallback';
  readonly enabled: boolean;
  readonly maxInputCharacters?: number;
  readonly maxInputSegments?: number;
  readonly providerOptions?: Record<string, unknown>;
  readonly capabilitySnapshot?: ProviderCapabilitySnapshot;
}

export interface ProviderRequestProfileConfig {
  readonly profileId: string;
  readonly displayName: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly enabled: boolean;
  readonly description?: string;
}

export type ProviderOptionValueType = 'string' | 'number' | 'boolean' | 'select';

export type ProviderOptionPlacement = 'provider_settings' | 'voice_profile' | 'synthesis_request';

export interface ProviderOptionChoice {
  readonly value: string;
  readonly label: string;
}

export interface ProviderOptionConfig {
  readonly optionKey: string;
  readonly displayName: string;
  readonly valueType: ProviderOptionValueType;
  readonly placements?: readonly ProviderOptionPlacement[];
  readonly description?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly defaultValue?: string | number | boolean;
  readonly choices?: readonly ProviderOptionChoice[];
}

export interface ProviderJob {
  readonly id: string;
  readonly novelId: string;
  readonly chapterId?: string;
  readonly type: ProviderJobType;
  readonly providerId: string;
  readonly modelId?: string;
  readonly inputHash: string;
  readonly status: ProviderJobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly attempt?: ProviderAttemptStatus;
}

export interface ProviderBudgetEstimate {
  readonly providerId: string;
  readonly modelId?: string;
  readonly inputCharacters?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly audioCharacters?: number;
  readonly audioSeconds?: number;
  readonly cacheHit?: boolean;
}

export interface TTSCacheItem {
  readonly id: string;
  readonly novelId: string;
  readonly chapterId: string;
  readonly cacheKey: string;
  readonly providerId: string;
  readonly providerModel?: string;
  readonly providerVersion?: string;
  readonly voiceProfileId: string;
  readonly speakerId?: string;
  readonly segmentIds: string[];
  readonly inputTextHash: string;
  readonly optionsHash: string;
  readonly audioObjectKey: string;
  readonly contentType?: string;
  readonly byteSize?: number;
  readonly audioHash?: string;
  readonly durationMs?: number;
  readonly renderFingerprint?: string;
  readonly voiceEntryFingerprint?: string;
  readonly pronunciationRevisionId?: string;
  readonly integrityState?: 'verified' | 'quarantined';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TTSCacheResolveInput {
  readonly providerId: string;
  readonly providerModel?: string;
  readonly providerVersion?: string;
  readonly voiceProfileId: string;
  readonly speakerId: string;
  readonly segmentIds: string[];
  readonly inputTextHash: string;
  readonly sampleTextId?: string;
  readonly renderSpec?: TTSRenderSpec;
  readonly providerOptions?: Record<string, unknown>;
  readonly audioCharacters?: number;
  readonly force?: boolean;
}

export interface TTSCacheResolveResult {
  readonly cacheHit: boolean;
  readonly cacheKey: string;
  readonly optionsHash: string;
  readonly cacheItem?: TTSCacheItem;
  readonly job?: ProviderJob;
}
