import type { VoiceProfile } from '@noveldesk/contracts';
import type {
  ProviderCatalogItem,
  ProviderModelConfig,
  TTSCacheItem,
} from '../../../../../src/providers/provider-jobs';
import {
  buildTTSRenderSpec,
  type TTSRenderFormat,
  type TTSRenderSpec,
} from '../../../../../src/providers/tts-render-spec';
import { serverTTSProviderIds, type ServerTTSProviderId } from '../../providers/server-provider-catalog.js';
import { isoString, mapJsonStringArray } from './database-row-contract.js';

export interface TTSCacheRow {
  id: string;
  book_id: string;
  chapter_id: string;
  cache_key: string;
  provider_id: string;
  provider_model: string | null;
  provider_version: string | null;
  voice_profile_id: string;
  speaker_id: string | null;
  segment_ids: unknown;
  input_text_hash: string;
  options_hash: string;
  audio_object_key: string;
  content_type: string | null;
  byte_size: number | null;
  audio_hash: string | null;
  duration_ms: number | null;
  integrity_state?: string | null;
  pronunciation_revision_id?: string | null;
  voice_entry_fingerprint?: string | null;
  stale_at?: Date | string | null;
  render_fingerprint?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface TTSVoiceProfileResolveRow {
  id: string;
  book_id: string;
  character_id: string | null;
  role: string;
  provider_id: string;
  provider_voice_id: string;
  provider_model: string | null;
  label: string;
  language: string | null;
  tone: string | null;
  speed: number | string;
  pitch: number | string | null;
  emotion_policy: string | null;
  provider_options: unknown;
  is_user_selected: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

export const serverTTSProviderSet = new Set<string>(serverTTSProviderIds);

export function isServerTTSProviderId(value: string | undefined): value is ServerTTSProviderId {
  return Boolean(value && serverTTSProviderSet.has(value));
}

export function ttsBudgetModelForProvider(
  provider: ProviderCatalogItem,
  modelId: string | undefined,
): ProviderModelConfig | undefined {
  return (
    (modelId ? provider.models.find((model) => model.modelId === modelId) : undefined) ??
    provider.models.find((model) => model.enabled) ??
    provider.models[0]
  );
}

export function ttsSynthesisBudgetRejection(input: {
  readonly budgetModel: ProviderModelConfig | undefined;
  readonly segmentCount: number;
  readonly audioCharacters: number;
}): Record<string, unknown> | undefined {
  const maxInputSegments = input.budgetModel?.maxInputSegments;
  if (maxInputSegments !== undefined && input.segmentCount > maxInputSegments) {
    return {
      error: 'TTS synthesis request exceeds provider segment budget',
      segmentCount: input.segmentCount,
      maxInputSegments,
    };
  }
  const maxInputCharacters = input.budgetModel?.maxInputCharacters;
  if (maxInputCharacters !== undefined && input.audioCharacters > maxInputCharacters) {
    return {
      error: 'TTS synthesis request exceeds provider character budget',
      audioCharacters: input.audioCharacters,
      maxInputCharacters,
    };
  }
  return undefined;
}

export function mapTTSCacheItem(row: TTSCacheRow): TTSCacheItem {
  return {
    id: row.id,
    novelId: row.book_id,
    chapterId: row.chapter_id,
    cacheKey: row.cache_key,
    providerId: row.provider_id,
    providerModel: row.provider_model ?? undefined,
    providerVersion: row.provider_version ?? undefined,
    voiceProfileId: row.voice_profile_id,
    speakerId: row.speaker_id ?? undefined,
    segmentIds: mapJsonStringArray(row.segment_ids),
    inputTextHash: row.input_text_hash,
    optionsHash: row.options_hash,
    audioObjectKey: row.audio_object_key,
    contentType: row.content_type ?? undefined,
    byteSize: row.byte_size ?? undefined,
    audioHash: row.audio_hash ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    renderFingerprint: row.render_fingerprint ?? undefined,
    voiceEntryFingerprint: row.voice_entry_fingerprint ?? undefined,
    pronunciationRevisionId: row.pronunciation_revision_id ?? undefined,
    integrityState: row.integrity_state === 'quarantined' ? 'quarantined' : 'verified',
    createdAt: isoString(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: isoString(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export function ttsRenderFormatFromOptions(options: Record<string, unknown>): TTSRenderFormat | undefined {
  const raw = options.responseFormat ?? options.outputFormat ?? options.format;
  return typeof raw === 'string' && ['mp3', 'wav', 'pcm', 'ogg', 'opus', 'aac', 'flac'].includes(raw)
    ? (raw as TTSRenderFormat)
    : undefined;
}

export function numberOption(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key];
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function stringOption(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function voiceProfileForRenderSpec(row: TTSVoiceProfileResolveRow): VoiceProfile {
  const providerOptions =
    row.provider_options && typeof row.provider_options === 'object' && !Array.isArray(row.provider_options)
      ? (row.provider_options as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    novelId: row.book_id,
    characterId: row.character_id ?? undefined,
    role: row.role as VoiceProfile['role'],
    providerId: row.provider_id,
    providerVoiceId: row.provider_voice_id,
    providerModel: row.provider_model ?? undefined,
    label: row.label,
    language: row.language ?? undefined,
    tone: row.tone ?? undefined,
    speed: Number(row.speed),
    pitch: row.pitch === null || row.pitch === undefined ? undefined : Number(row.pitch),
    emotionPolicy: row.emotion_policy ?? undefined,
    providerOptions,
    isUserSelected: Boolean(row.is_user_selected),
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
  };
}

export function validateRequestedTTSRenderSpec(input: {
  readonly spec: TTSRenderSpec;
  readonly bookId: string;
  readonly chapterId: string;
  readonly providerId: string;
  readonly voiceProfileId: string;
  readonly speakerId: string;
  readonly segmentIds: string[];
  readonly inputTextHash: string;
}): void {
  if (input.spec.novelId !== input.bookId) throw new Error('renderSpec.novelId does not match chapter book');
  if (input.spec.chapterId !== input.chapterId) throw new Error('renderSpec.chapterId does not match request chapter');
  if (input.spec.providerId !== input.providerId)
    throw new Error('renderSpec.providerId does not match request provider');
  if (input.spec.voiceProfileId !== input.voiceProfileId)
    throw new Error('renderSpec.voiceProfileId does not match request voice profile');
  if (input.spec.speakerId !== input.speakerId) throw new Error('renderSpec.speakerId does not match request speaker');
  if (input.spec.inputTextHash !== input.inputTextHash)
    throw new Error('renderSpec.inputTextHash does not match request inputTextHash');
  const renderSegmentIds = input.spec.segmentAnchors.map((anchor) => anchor.segmentId);
  if (JSON.stringify(renderSegmentIds) !== JSON.stringify(input.segmentIds)) {
    throw new Error('renderSpec.segmentAnchors must match request segmentIds order');
  }
}

export function buildServerTTSRenderSpec(input: {
  readonly bookId: string;
  readonly chapterId: string;
  readonly providerId: string;
  readonly providerModel?: string;
  readonly providerVersion?: string;
  readonly voiceProfile: TTSVoiceProfileResolveRow;
  readonly speakerId: string;
  readonly segmentIds: string[];
  readonly inputTextHash: string;
  readonly optionsHash: string;
  readonly requestedRenderSpec?: TTSRenderSpec;
  readonly providerOptions: Record<string, unknown>;
}): TTSRenderSpec {
  if (input.requestedRenderSpec) {
    validateRequestedTTSRenderSpec({
      spec: input.requestedRenderSpec,
      bookId: input.bookId,
      chapterId: input.chapterId,
      providerId: input.providerId,
      voiceProfileId: input.voiceProfile.id,
      speakerId: input.speakerId,
      segmentIds: input.segmentIds,
      inputTextHash: input.inputTextHash,
    });
  }
  return buildTTSRenderSpec({
    novelId: input.bookId,
    chapterId: input.chapterId,
    speakerId: input.speakerId,
    voiceProfile: voiceProfileForRenderSpec(input.voiceProfile),
    providerModel: input.providerModel,
    providerVersion: input.providerVersion,
    segmentAnchors: input.requestedRenderSpec?.segmentAnchors ?? input.segmentIds.map((segmentId) => ({ segmentId })),
    inputTextHash: input.inputTextHash,
    providerOptionsHash: input.optionsHash,
    format: input.requestedRenderSpec?.format ?? ttsRenderFormatFromOptions(input.providerOptions),
    speed: input.requestedRenderSpec?.speed ?? numberOption(input.providerOptions, 'speed'),
    pitch: input.requestedRenderSpec?.pitch ?? numberOption(input.providerOptions, 'pitch'),
    tone: input.requestedRenderSpec?.tone ?? stringOption(input.providerOptions, 'tone'),
    emotion: input.requestedRenderSpec?.emotion ?? stringOption(input.providerOptions, 'emotion'),
    pronunciationRevisionId: input.requestedRenderSpec?.pronunciationRevisionId,
    pronunciationFingerprint: input.requestedRenderSpec?.pronunciationFingerprint,
    voiceEntryFingerprint: input.requestedRenderSpec?.voiceEntryFingerprint,
    appliedControls: input.requestedRenderSpec?.appliedControls,
    alignmentMode: input.requestedRenderSpec?.alignmentMode,
    chunkerVersion: input.requestedRenderSpec?.chunkerVersion,
    synthesisProjectionVersion: input.requestedRenderSpec?.synthesisProjectionVersion,
  });
}
