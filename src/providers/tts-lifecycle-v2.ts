import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { LabeledSegment, VoiceProfile } from '../domain/types';
import type { PronunciationProfileV1 } from './voice-product';
import { projectPronunciation } from './voice-product';
import type { TTSCapabilitySnapshot } from './provider-capability';

export const TTS_SYNTHESIS_PROJECTION_VERSION = 'tts-projection-v2' as const;
export const TTS_CHUNKER_VERSION = 'exact-segment-chunker-v2' as const;

export interface AppliedTTSControls {
  readonly speed: number;
  readonly pitch?: number;
  readonly emotion: string;
  readonly tone?: string;
  readonly providerInstruction?: string;
  readonly ignored: readonly { readonly control: string; readonly reason: string }[];
  readonly policyVersion: typeof TTS_SYNTHESIS_PROJECTION_VERSION;
  readonly hash: string;
}

export interface TTSRenderSourceV2 {
  readonly segmentId: string;
  readonly paragraphId: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly textHash: string;
  readonly text: string;
  readonly speakerId: string;
  readonly segment: Pick<LabeledSegment, 'emotion' | 'confidence' | 'prosodyIntent'>;
  readonly voiceProfile: VoiceProfile;
  readonly voiceEntryFingerprint: string;
}

export interface TTSRenderItemV2 {
  readonly renderItemId: string;
  readonly sequence: number;
  readonly sourceSegments: readonly {
    readonly segmentId: string;
    readonly paragraphId: string;
    readonly startOffset: number;
    readonly endOffset: number;
    readonly textHash: string;
  }[];
  readonly alignmentMode: 'exact_segment' | 'provider_marks' | 'estimated_chunk';
  readonly speakerId: string;
  readonly voiceProfileId: string;
  readonly voiceBindingFingerprint: string;
  readonly pronunciationFingerprint: string;
  readonly appliedControls: AppliedTTSControls;
  readonly chunkerVersion: typeof TTS_CHUNKER_VERSION;
  readonly synthesisProjectionVersion: typeof TTS_SYNTHESIS_PROJECTION_VERSION;
  readonly renderFingerprint: string;
  readonly text: string;
  readonly estimated: {
    readonly inputBytes: number;
    readonly durationMs?: number;
    readonly costMinorUnits?: number;
  };
}

export interface TTSRenderPlanV2 {
  readonly id: string;
  readonly novelId: string;
  readonly chapterId: string;
  readonly capabilitySnapshotId: string;
  readonly items: readonly TTSRenderItemV2[];
  readonly fingerprint: string;
  readonly sourceBytes: number;
  readonly estimatedDurationMs: number;
  readonly admission: {
    readonly accepted: boolean;
    readonly reasons: readonly string[];
    readonly itemCount: number;
    readonly maxChildCount: number;
    readonly estimatedCostMinorUnits?: number;
    readonly hardBudgetMinorUnits?: number;
  };
  readonly createdAt: string;
}

export type TTSLifecycleState =
  | 'not_planned'
  | 'planned'
  | 'waiting_voice_approval'
  | 'queued'
  | 'synthesizing'
  | 'partial'
  | 'audio_cache_ready'
  | 'cancelling'
  | 'cancelled'
  | 'billed_possible'
  | 'failed_retryable'
  | 'outcome_unknown'
  | 'reconciling'
  | 'failed_review';

export type TTSRenderItemStatus =
  | 'planned'
  | 'cache_hit'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'missing'
  | 'stale'
  | 'corrupt';

export interface TTSLifecycleItemV2 {
  readonly renderItemId: string;
  readonly renderFingerprint: string;
  readonly status: TTSRenderItemStatus;
  readonly durationMs?: number;
  readonly costMinorUnits?: number;
  readonly errorCode?: string;
}

export interface TTSLifecycleSnapshotV2 {
  readonly planId: string;
  readonly planFingerprint: string;
  readonly state: TTSLifecycleState;
  readonly items: readonly TTSLifecycleItemV2[];
  readonly progress: Record<TTSRenderItemStatus, number>;
  readonly ready: boolean;
  readonly systemFallbackUsed: boolean;
  readonly updatedAt: string;
}

export interface TTSAudioIntegrityInput {
  readonly renderItem: TTSRenderItemV2;
  readonly expectedAudioHash?: string;
  readonly actualAudioHash?: string;
  readonly expectedByteSize?: number;
  readonly actualByteSize: number;
  readonly contentType?: string;
  readonly durationMs?: number;
  readonly codecSupported?: boolean;
  readonly objectExists: boolean;
}

export interface TTSAudioIntegrityResult {
  readonly state: 'verified' | 'quarantined';
  readonly reasons: readonly string[];
  readonly renderFingerprint: string;
}

export function probeTTSAudioContainer(
  audio: Uint8Array,
  contentType: string,
): { readonly ok: boolean; readonly reason?: string } {
  if (audio.byteLength === 0) return { ok: false, reason: 'empty_payload' };
  const type = contentType.toLowerCase().split(';')[0].trim();
  if (!type.startsWith('audio/')) return { ok: false, reason: 'invalid_content_type' };
  const ascii = (start: number, length: number) => String.fromCharCode(...audio.slice(start, start + length));
  const valid =
    type === 'audio/pcm' ||
    type === 'audio/l16' ||
    ((type === 'audio/mpeg' || type === 'audio/mp3') &&
      (ascii(0, 3) === 'ID3' || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0))) ||
    ((type === 'audio/wav' || type === 'audio/wave' || type === 'audio/x-wav') &&
      ascii(0, 4) === 'RIFF' &&
      ascii(8, 4) === 'WAVE') ||
    ((type === 'audio/ogg' || type === 'audio/opus') && ascii(0, 4) === 'OggS') ||
    (type === 'audio/flac' && ascii(0, 4) === 'fLaC') ||
    ((type === 'audio/aac' || type === 'audio/aacp') && audio[0] === 0xff && (audio[1] & 0xf6) === 0xf0);
  return valid ? { ok: true } : { ok: false, reason: 'codec_container_mismatch' };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function projectAppliedTTSControls(input: {
  readonly segment: Pick<LabeledSegment, 'emotion' | 'confidence' | 'prosodyIntent'>;
  readonly voiceProfile: VoiceProfile;
  readonly capability: TTSCapabilitySnapshot;
  readonly userOverride?: {
    readonly emotion?: string;
    readonly tone?: string;
    readonly speed?: number;
    readonly pitch?: number;
  };
}): AppliedTTSControls {
  const supported = new Set(input.capability.supportedControls.map((item) => item.toLowerCase()));
  const ignored: Array<{ control: string; reason: string }> = [];
  const requestedEmotion = input.userOverride?.emotion ?? input.segment.emotion ?? 'neutral';
  const emotion = input.segment.confidence < 0.6 && !input.userOverride?.emotion ? 'neutral' : requestedEmotion;
  const requestedSpeed = input.userOverride?.speed ?? input.voiceProfile.speed ?? 1;
  const speed = supported.has('speed') ? clamp(requestedSpeed, 0.25, 4) : 1;
  if (!supported.has('speed') && requestedSpeed !== 1)
    ignored.push({ control: 'speed', reason: 'unsupported_by_provider' });
  const requestedPitch = input.userOverride?.pitch ?? input.voiceProfile.pitch;
  const pitch = requestedPitch !== undefined && supported.has('pitch') ? requestedPitch : undefined;
  if (requestedPitch !== undefined && !supported.has('pitch'))
    ignored.push({ control: 'pitch', reason: 'unsupported_by_provider' });
  const requestedTone = input.userOverride?.tone ?? input.voiceProfile.tone ?? input.segment.prosodyIntent?.delivery;
  const tone = requestedTone && (supported.has('tone') || supported.has('style')) ? requestedTone : undefined;
  if (requestedTone && !tone) ignored.push({ control: 'tone', reason: 'unsupported_by_provider' });
  const appliedEmotion = supported.has('emotion') || supported.has('style') ? emotion : 'neutral';
  if (emotion !== 'neutral' && appliedEmotion === 'neutral')
    ignored.push({ control: 'emotion', reason: 'unsupported_by_provider' });
  const core = {
    speed,
    pitch: pitch ?? null,
    emotion: appliedEmotion,
    tone: tone ?? '',
    providerInstruction: tone ?? '',
    ignored,
    policyVersion: TTS_SYNTHESIS_PROJECTION_VERSION,
  };
  return { ...core, pitch, tone, providerInstruction: tone, hash: structuredIntegrityHash(core) };
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function fits(text: string, capability: TTSCapabilitySnapshot, speed: number, providerInstruction?: string): boolean {
  return (
    (capability.maxTextCharacters === undefined || text.length <= capability.maxTextCharacters) &&
    (capability.maxTextBytes === undefined || utf8Bytes(text) <= capability.maxTextBytes) &&
    (capability.maxInputTokens === undefined || Math.ceil(text.length / 3) <= capability.maxInputTokens) &&
    (capability.maxPromptBytes === undefined || utf8Bytes(providerInstruction ?? '') <= capability.maxPromptBytes) &&
    (capability.maxDurationMs === undefined ||
      Math.ceil(((text.length / 6) * 1000) / speed) <= capability.maxDurationMs)
  );
}

function splitProjectedSource(
  text: string,
  capability: TTSCapabilitySnapshot,
  speed: number,
  providerInstruction: string | undefined,
  project: (source: string) => ReturnType<typeof projectPronunciation>,
): Array<{
  readonly projected: ReturnType<typeof projectPronunciation>;
  readonly start: number;
  readonly end: number;
}> {
  const whole = project(text);
  if (fits(whole.text, capability, speed, providerInstruction))
    return [{ projected: whole, start: 0, end: text.length }];
  const chunks: Array<{
    projected: ReturnType<typeof projectPronunciation>;
    start: number;
    end: number;
  }> = [];
  for (let start = 0; start < text.length;) {
    let low = start + 1;
    let high = text.length;
    let bestEnd = start;
    let bestProjection: ReturnType<typeof projectPronunciation> | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const projected = project(text.slice(start, middle));
      if (fits(projected.text, capability, speed, providerInstruction)) {
        bestEnd = middle;
        bestProjection = projected;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (!bestProjection || bestEnd <= start) throw new Error('Provider TTS limits cannot admit projected source');
    chunks.push({ projected: bestProjection, start, end: bestEnd });
    start = bestEnd;
  }
  return chunks;
}

export function buildTTSRenderPlanV2(input: {
  readonly novelId: string;
  readonly chapterId: string;
  readonly sources: readonly TTSRenderSourceV2[];
  readonly capability: TTSCapabilitySnapshot;
  readonly pronunciationProfile: PronunciationProfileV1;
  readonly maxChildCount?: number;
  readonly hardBudgetMinorUnits?: number;
  readonly estimatedCostPerThousandCharactersMinorUnits?: number;
  readonly createdAt?: string;
}): TTSRenderPlanV2 {
  const maxChildCount = Math.max(1, Math.floor(input.maxChildCount ?? 10_000));
  const items: TTSRenderItemV2[] = [];
  for (const source of input.sources) {
    const controls = projectAppliedTTSControls({
      segment: source.segment,
      voiceProfile: source.voiceProfile,
      capability: input.capability,
    });
    const chunks = splitProjectedSource(
      source.text,
      input.capability,
      controls.speed,
      controls.providerInstruction,
      (text) =>
        projectPronunciation({
          text,
          profile: input.pronunciationProfile,
          providerId: source.voiceProfile.providerId,
          locale: source.voiceProfile.language,
          chapterId: input.chapterId,
        }),
    );
    for (const chunk of chunks) {
      const sourceAnchor = {
        segmentId: source.segmentId,
        paragraphId: source.paragraphId,
        startOffset: source.startOffset + chunk.start,
        endOffset: source.startOffset + chunk.end,
        textHash: source.textHash,
      };
      const inputBytes = utf8Bytes(chunk.projected.text);
      const estimatedDurationMs = Math.ceil(((chunk.projected.text.length / 6) * 1000) / controls.speed);
      const estimatedCostMinorUnits =
        input.estimatedCostPerThousandCharactersMinorUnits === undefined
          ? undefined
          : Math.ceil((chunk.projected.text.length / 1000) * input.estimatedCostPerThousandCharactersMinorUnits);
      const identity = {
        sourceAnchor,
        speakerId: source.speakerId,
        voiceProfileId: source.voiceProfile.id,
        voiceEntryFingerprint: source.voiceEntryFingerprint,
        providerId: source.voiceProfile.providerId,
        providerModel: source.voiceProfile.providerModel ?? '',
        controlsHash: controls.hash,
        pronunciationFingerprint: chunk.projected.fingerprint,
        chunkerVersion: TTS_CHUNKER_VERSION,
        synthesisProjectionVersion: TTS_SYNTHESIS_PROJECTION_VERSION,
        text: chunk.projected.text,
      };
      const renderFingerprint = structuredIntegrityHash(identity);
      items.push({
        renderItemId: persistentId128('tts_render_item_v2', [input.novelId, input.chapterId, renderFingerprint]),
        sequence: items.length,
        sourceSegments: [sourceAnchor],
        alignmentMode: 'exact_segment',
        speakerId: source.speakerId,
        voiceProfileId: source.voiceProfile.id,
        voiceBindingFingerprint: structuredIntegrityHash({
          profileId: source.voiceProfile.id,
          entry: source.voiceEntryFingerprint,
        }),
        pronunciationFingerprint: chunk.projected.fingerprint,
        appliedControls: controls,
        chunkerVersion: TTS_CHUNKER_VERSION,
        synthesisProjectionVersion: TTS_SYNTHESIS_PROJECTION_VERSION,
        renderFingerprint,
        text: chunk.projected.text,
        estimated: { inputBytes, durationMs: estimatedDurationMs, costMinorUnits: estimatedCostMinorUnits },
      });
    }
  }
  const sourceBytes = items.reduce((sum, item) => sum + item.estimated.inputBytes, 0);
  const estimatedDurationMs = items.reduce((sum, item) => sum + (item.estimated.durationMs ?? 0), 0);
  const estimatedCostMinorUnits = items.some((item) => item.estimated.costMinorUnits !== undefined)
    ? items.reduce((sum, item) => sum + (item.estimated.costMinorUnits ?? 0), 0)
    : undefined;
  const reasons: string[] = [];
  if (items.length > maxChildCount) reasons.push('max_child_count_exceeded');
  if (
    input.hardBudgetMinorUnits !== undefined &&
    estimatedCostMinorUnits !== undefined &&
    estimatedCostMinorUnits > input.hardBudgetMinorUnits
  )
    reasons.push('hard_budget_exceeded');
  const fingerprint = structuredIntegrityHash(items.map((item) => item.renderFingerprint));
  return {
    id: persistentId128('tts_render_plan_v2', [input.novelId, input.chapterId, input.capability.id, fingerprint]),
    novelId: input.novelId,
    chapterId: input.chapterId,
    capabilitySnapshotId: input.capability.id,
    items,
    fingerprint,
    sourceBytes,
    estimatedDurationMs,
    admission: {
      accepted: reasons.length === 0,
      reasons,
      itemCount: items.length,
      maxChildCount,
      estimatedCostMinorUnits,
      hardBudgetMinorUnits: input.hardBudgetMinorUnits,
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

const itemStatuses: readonly TTSRenderItemStatus[] = [
  'planned',
  'cache_hit',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
  'missing',
  'stale',
  'corrupt',
];

export function summarizeTTSLifecycle(input: {
  readonly plan: TTSRenderPlanV2;
  readonly items: readonly TTSLifecycleItemV2[];
  readonly waitingVoiceApproval?: boolean;
  readonly cancelling?: boolean;
  readonly systemFallbackUsed?: boolean;
  readonly updatedAt?: string;
}): TTSLifecycleSnapshotV2 {
  const current = new Map(
    input.items
      .filter((item) =>
        input.plan.items.some(
          (planItem) =>
            planItem.renderItemId === item.renderItemId && planItem.renderFingerprint === item.renderFingerprint,
        ),
      )
      .map((item) => [item.renderItemId, item]),
  );
  const items = input.plan.items.map(
    (item) =>
      current.get(item.renderItemId) ?? {
        renderItemId: item.renderItemId,
        renderFingerprint: item.renderFingerprint,
        status: 'planned' as const,
      },
  );
  const progress = Object.fromEntries(
    itemStatuses.map((status) => [status, items.filter((item) => item.status === status).length]),
  ) as Record<TTSRenderItemStatus, number>;
  const ready = items.length > 0 && items.every((item) => item.status === 'cache_hit' || item.status === 'succeeded');
  const hasPartial = items.some((item) => item.status === 'cache_hit' || item.status === 'succeeded') && !ready;
  const state: TTSLifecycleState = input.waitingVoiceApproval
    ? 'waiting_voice_approval'
    : input.cancelling
      ? 'cancelling'
      : ready
        ? 'audio_cache_ready'
        : progress.unknown
          ? 'outcome_unknown'
          : hasPartial
            ? 'partial'
            : progress.running
              ? 'synthesizing'
              : progress.queued
                ? 'queued'
                : progress.failed || progress.missing || progress.stale || progress.corrupt
                  ? 'failed_retryable'
                  : 'planned';
  return {
    planId: input.plan.id,
    planFingerprint: input.plan.fingerprint,
    state,
    items,
    progress,
    ready,
    systemFallbackUsed: input.systemFallbackUsed ?? false,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}

export function retryableTTSRenderItemIds(snapshot: TTSLifecycleSnapshotV2): string[] {
  return snapshot.items
    .filter((item) => ['failed', 'missing', 'stale', 'corrupt'].includes(item.status))
    .map((item) => item.renderItemId);
}

export function inspectTTSAudioIntegrity(input: TTSAudioIntegrityInput): TTSAudioIntegrityResult {
  const reasons: string[] = [];
  if (!input.objectExists) reasons.push('object_missing');
  if (input.actualByteSize <= 0) reasons.push('empty_payload');
  if (input.expectedByteSize !== undefined && input.expectedByteSize !== input.actualByteSize)
    reasons.push('byte_size_mismatch');
  if (input.expectedAudioHash && input.actualAudioHash !== input.expectedAudioHash) reasons.push('audio_hash_mismatch');
  if (!input.contentType?.startsWith('audio/')) reasons.push('invalid_content_type');
  if (input.codecSupported === false) reasons.push('unsupported_codec');
  if (
    input.durationMs !== undefined &&
    (input.durationMs <= 0 ||
      input.durationMs > (input.renderItem.estimated.durationMs ?? input.durationMs) * 4 + 30_000)
  )
    reasons.push('duration_out_of_range');
  return {
    state: reasons.length === 0 ? 'verified' : 'quarantined',
    reasons,
    renderFingerprint: input.renderItem.renderFingerprint,
  };
}
