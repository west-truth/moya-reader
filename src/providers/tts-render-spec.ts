import type { LabeledSegment, VoiceProfile } from '../domain/types';
import { matchesTTSRenderSpecIntegrityHash, ttsRenderSpecIntegrityHash } from '../domain/identity/tts-identities';
import type { TTSSynthesisInput } from './tts';
import type { AppliedTTSControls } from './tts-lifecycle-v2';

export type TTSRenderFormat = NonNullable<TTSSynthesisInput['format']>;

export interface TTSRenderSegmentAnchor {
  readonly segmentId: string;
  readonly paragraphId?: string;
  readonly startOffset?: number;
  readonly endOffset?: number;
  readonly segmentTextHash?: string;
}

export interface TTSRenderSpec {
  readonly novelId: string;
  readonly chapterId: string;
  readonly contentRevision?: string;
  readonly chapterTextHash?: string;
  readonly speakerId: string;
  readonly voiceProfileId: string;
  readonly providerId: string;
  readonly providerModel?: string;
  readonly providerVersion?: string;
  readonly providerVoiceId?: string;
  readonly voiceProfileRevision?: string;
  readonly segmentAnchors: TTSRenderSegmentAnchor[];
  readonly inputTextHash: string;
  readonly providerOptionsHash: string;
  readonly format: TTSRenderFormat;
  readonly speed: number;
  readonly pitch?: number;
  readonly tone?: string;
  readonly emotion?: string;
  readonly emotionPolicy?: string;
  readonly pronunciationRevisionId?: string;
  readonly pronunciationFingerprint?: string;
  readonly voiceEntryFingerprint?: string;
  readonly appliedControls?: AppliedTTSControls;
  readonly alignmentMode?: 'exact_segment' | 'provider_marks' | 'estimated_chunk';
  readonly chunkerVersion?: string;
  readonly synthesisProjectionVersion?: string;
}

export interface BuildTTSRenderSpecInput {
  readonly novelId: string;
  readonly chapterId: string;
  readonly contentRevision?: string;
  readonly chapterTextHash?: string;
  readonly speakerId: string;
  readonly voiceProfile: VoiceProfile;
  readonly providerModel?: string;
  readonly providerVersion?: string;
  readonly segmentAnchors: TTSRenderSegmentAnchor[];
  readonly inputTextHash: string;
  readonly providerOptionsHash: string;
  readonly format?: TTSRenderFormat;
  readonly speed?: number;
  readonly pitch?: number;
  readonly tone?: string;
  readonly emotion?: string;
  readonly pronunciationRevisionId?: string;
  readonly pronunciationFingerprint?: string;
  readonly voiceEntryFingerprint?: string;
  readonly appliedControls?: AppliedTTSControls;
  readonly alignmentMode?: TTSRenderSpec['alignmentMode'];
  readonly chunkerVersion?: string;
  readonly synthesisProjectionVersion?: string;
}

export function segmentAnchorsFromSegments(segments: LabeledSegment[], segmentIds: string[]): TTSRenderSegmentAnchor[] {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  return segmentIds.map((segmentId) => {
    const segment = byId.get(segmentId);
    return segment
      ? {
          segmentId,
          paragraphId: segment.paragraphId,
          startOffset: segment.startOffset,
          endOffset: segment.endOffset,
          segmentTextHash: segment.segmentTextHash,
        }
      : { segmentId };
  });
}

export function buildTTSRenderSpec(input: BuildTTSRenderSpecInput): TTSRenderSpec {
  return normalizeTTSRenderSpec({
    novelId: input.novelId,
    chapterId: input.chapterId,
    contentRevision: input.contentRevision,
    chapterTextHash: input.chapterTextHash,
    speakerId: input.speakerId,
    voiceProfileId: input.voiceProfile.id,
    providerId: input.voiceProfile.providerId,
    providerModel: input.providerModel ?? input.voiceProfile.providerModel,
    providerVersion: input.providerVersion,
    providerVoiceId: input.voiceProfile.providerVoiceId,
    voiceProfileRevision:
      input.voiceProfile.updatedAt ??
      ttsRenderSpecIntegrityHash({
        id: input.voiceProfile.id,
        providerId: input.voiceProfile.providerId,
        providerModel: input.voiceProfile.providerModel ?? '',
        providerVoiceId: input.voiceProfile.providerVoiceId,
        speed: input.voiceProfile.speed,
        pitch: input.voiceProfile.pitch ?? null,
        tone: input.voiceProfile.tone ?? '',
        emotionPolicy: input.voiceProfile.emotionPolicy ?? '',
      }),
    segmentAnchors: input.segmentAnchors,
    inputTextHash: input.inputTextHash,
    providerOptionsHash: input.providerOptionsHash,
    format: input.format ?? 'mp3',
    speed: input.speed ?? input.voiceProfile.speed,
    pitch: input.pitch ?? input.voiceProfile.pitch,
    tone: input.tone ?? input.voiceProfile.tone,
    emotion: input.emotion,
    emotionPolicy: input.voiceProfile.emotionPolicy,
    pronunciationRevisionId: input.pronunciationRevisionId,
    pronunciationFingerprint: input.pronunciationFingerprint,
    voiceEntryFingerprint: input.voiceEntryFingerprint,
    appliedControls: input.appliedControls,
    alignmentMode: input.alignmentMode,
    chunkerVersion: input.chunkerVersion,
    synthesisProjectionVersion: input.synthesisProjectionVersion,
  });
}

export function normalizeTTSRenderSpec(value: unknown): TTSRenderSpec {
  const body = recordValue(value, 'TTS render spec');
  const segmentAnchors = arrayValue(body.segmentAnchors, 'TTS render spec segmentAnchors').map(normalizeSegmentAnchor);
  if (segmentAnchors.length === 0) throw new Error('TTS render spec segmentAnchors must not be empty');
  const speed = numberValue(body.speed, 'TTS render spec speed');
  if (speed <= 0 || speed > 4) throw new Error('TTS render spec speed must be greater than 0 and at most 4');
  return {
    novelId: stringValue(body.novelId, 'TTS render spec novelId'),
    chapterId: stringValue(body.chapterId, 'TTS render spec chapterId'),
    contentRevision: optionalString(body.contentRevision),
    chapterTextHash: optionalString(body.chapterTextHash),
    speakerId: stringValue(body.speakerId, 'TTS render spec speakerId'),
    voiceProfileId: stringValue(body.voiceProfileId, 'TTS render spec voiceProfileId'),
    providerId: stringValue(body.providerId, 'TTS render spec providerId'),
    providerModel: optionalString(body.providerModel),
    providerVersion: optionalString(body.providerVersion),
    providerVoiceId: optionalString(body.providerVoiceId),
    voiceProfileRevision: optionalString(body.voiceProfileRevision),
    segmentAnchors,
    inputTextHash: stringValue(body.inputTextHash, 'TTS render spec inputTextHash'),
    providerOptionsHash: stringValue(body.providerOptionsHash, 'TTS render spec providerOptionsHash'),
    format: renderFormatValue(body.format),
    speed,
    pitch: optionalNumber(body.pitch, 'TTS render spec pitch'),
    tone: optionalString(body.tone),
    emotion: optionalString(body.emotion),
    emotionPolicy: optionalString(body.emotionPolicy),
    pronunciationRevisionId: optionalString(body.pronunciationRevisionId),
    pronunciationFingerprint: optionalString(body.pronunciationFingerprint),
    voiceEntryFingerprint: optionalString(body.voiceEntryFingerprint),
    appliedControls: normalizeAppliedControls(body.appliedControls),
    alignmentMode: alignmentModeValue(body.alignmentMode),
    chunkerVersion: optionalString(body.chunkerVersion),
    synthesisProjectionVersion: optionalString(body.synthesisProjectionVersion),
  };
}

export function ttsRenderSpecIdentity(spec: TTSRenderSpec): Record<string, unknown> {
  return {
    novelId: spec.novelId,
    chapterId: spec.chapterId,
    contentRevision: spec.contentRevision ?? '',
    chapterTextHash: spec.chapterTextHash ?? '',
    speakerId: spec.speakerId,
    voiceProfileId: spec.voiceProfileId,
    providerId: spec.providerId,
    providerModel: spec.providerModel ?? '',
    providerVersion: spec.providerVersion ?? '',
    providerVoiceId: spec.providerVoiceId ?? '',
    voiceProfileRevision: spec.voiceProfileRevision ?? '',
    segmentAnchors: spec.segmentAnchors.map((anchor) => ({
      segmentId: anchor.segmentId,
      paragraphId: anchor.paragraphId ?? '',
      startOffset: anchor.startOffset ?? null,
      endOffset: anchor.endOffset ?? null,
      segmentTextHash: anchor.segmentTextHash ?? '',
    })),
    inputTextHash: spec.inputTextHash,
    providerOptionsHash: spec.providerOptionsHash,
    format: spec.format,
    speed: spec.speed,
    pitch: spec.pitch ?? null,
    tone: spec.tone ?? '',
    emotion: spec.emotion ?? '',
    emotionPolicy: spec.emotionPolicy ?? '',
    pronunciationRevisionId: spec.pronunciationRevisionId ?? '',
    pronunciationFingerprint: spec.pronunciationFingerprint ?? '',
    voiceEntryFingerprint: spec.voiceEntryFingerprint ?? '',
    appliedControls: spec.appliedControls ?? null,
    alignmentMode: spec.alignmentMode ?? 'exact_segment',
    chunkerVersion: spec.chunkerVersion ?? '',
    synthesisProjectionVersion: spec.synthesisProjectionVersion ?? '',
  };
}

export function ttsRenderSpecHash(spec: TTSRenderSpec): string {
  return ttsRenderSpecIntegrityHash(ttsRenderSpecIdentity(spec));
}

export function matchesTTSRenderSpecHash(value: string, spec: TTSRenderSpec): boolean {
  return matchesTTSRenderSpecIntegrityHash(value, ttsRenderSpecIdentity(spec));
}

function normalizeSegmentAnchor(value: unknown): TTSRenderSegmentAnchor {
  const body = recordValue(value, 'TTS render segment anchor');
  const startOffset = optionalNumber(body.startOffset, 'TTS render segment anchor startOffset');
  const endOffset = optionalNumber(body.endOffset, 'TTS render segment anchor endOffset');
  if (startOffset !== undefined && (!Number.isInteger(startOffset) || startOffset < 0)) {
    throw new Error('TTS render segment anchor startOffset must be a non-negative integer');
  }
  if (endOffset !== undefined && (!Number.isInteger(endOffset) || endOffset <= 0)) {
    throw new Error('TTS render segment anchor endOffset must be a positive integer');
  }
  if (startOffset !== undefined && endOffset !== undefined && endOffset <= startOffset) {
    throw new Error('TTS render segment anchor endOffset must be greater than startOffset');
  }
  return {
    segmentId: stringValue(body.segmentId, 'TTS render segment anchor segmentId'),
    paragraphId: optionalString(body.paragraphId),
    startOffset,
    endOffset,
    segmentTextHash: optionalString(body.segmentTextHash),
  };
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number`);
  return parsed;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number`);
  return parsed;
}

function renderFormatValue(value: unknown): TTSRenderFormat {
  const format = optionalString(value) ?? 'mp3';
  if (['mp3', 'wav', 'pcm', 'ogg', 'opus', 'aac', 'flac'].includes(format)) return format as TTSRenderFormat;
  throw new Error(`Unsupported TTS render format: ${format}`);
}

function alignmentModeValue(value: unknown): TTSRenderSpec['alignmentMode'] {
  const mode = optionalString(value);
  if (mode === undefined || mode === 'exact_segment' || mode === 'provider_marks' || mode === 'estimated_chunk')
    return mode;
  throw new Error(`Unsupported TTS alignment mode: ${mode}`);
}

function normalizeAppliedControls(value: unknown): AppliedTTSControls | undefined {
  if (value === undefined || value === null) return undefined;
  const body = recordValue(value, 'TTS applied controls');
  const ignored = body.ignored === undefined ? [] : arrayValue(body.ignored, 'TTS applied controls ignored');
  return {
    speed: numberValue(body.speed, 'TTS applied controls speed'),
    pitch: optionalNumber(body.pitch, 'TTS applied controls pitch'),
    emotion: stringValue(body.emotion, 'TTS applied controls emotion'),
    tone: optionalString(body.tone),
    providerInstruction: optionalString(body.providerInstruction),
    ignored: ignored.map((item) => {
      const ignoredBody = recordValue(item, 'TTS ignored control');
      return {
        control: stringValue(ignoredBody.control, 'TTS ignored control name'),
        reason: stringValue(ignoredBody.reason, 'TTS ignored control reason'),
      };
    }),
    policyVersion: 'tts-projection-v2',
    hash: stringValue(body.hash, 'TTS applied controls hash'),
  };
}
