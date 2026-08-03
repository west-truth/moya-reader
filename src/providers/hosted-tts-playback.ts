import type { LabeledSegment, Paragraph, VoiceProfile } from '../domain/types';
import { ttsInputTextIntegrityHash, ttsProviderOptionsIntegrityHash } from '../domain/identity/tts-identities';
import type { TTSCacheResolveInput } from './provider-jobs';
import { buildTTSRenderSpec, type TTSRenderFormat, type TTSRenderSegmentAnchor } from './tts-render-spec';
import type { PlayableTtsSegment } from './tts-playback';
import { resolveTTSCapabilitySnapshot, type TTSCapabilitySnapshot } from './provider-capability';
import { projectAppliedTTSControls, TTS_CHUNKER_VERSION, TTS_SYNTHESIS_PROJECTION_VERSION } from './tts-lifecycle-v2';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { TTS_NEUTRAL_SAMPLE_KO_V1, ttsVoiceSampleSegmentId, ttsVoiceSampleText } from './tts-voice-samples';

export interface HostedTTSCacheRequestInput {
  readonly paragraph: Paragraph;
  readonly playable: PlayableTtsSegment;
  readonly segments: LabeledSegment[];
  readonly voiceProfiles: VoiceProfile[];
  readonly contentRevision?: string;
  readonly chapterTextHash?: string;
  readonly providerOptionsByProvider?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly modelByProvider?: Readonly<Record<string, string>>;
  readonly pronunciationRevisionId?: string;
  readonly pronunciationFingerprint?: string;
  readonly capability?: TTSCapabilitySnapshot;
  readonly voiceEntryFingerprintByVoiceId?: Readonly<Record<string, string>>;
  readonly pitchOverride?: number;
}

export interface HostedTTSCacheRequestResult {
  readonly request: TTSCacheResolveInput;
  readonly voiceProfile: VoiceProfile;
  readonly text: string;
}

export function buildHostedNeutralVoiceSampleRequest(input: {
  readonly novelId: string;
  readonly chapterId: string;
  readonly voiceProfile: VoiceProfile;
  readonly providerOptionsByProvider?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly modelByProvider?: Readonly<Record<string, string>>;
  readonly pronunciationRevisionId?: string;
  readonly capability?: TTSCapabilitySnapshot;
  readonly voiceEntryFingerprint?: string;
}): HostedTTSCacheRequestResult | undefined {
  const voiceProfile = input.voiceProfile;
  if (voiceProfile.providerId === 'system' || hasSecretLikeKeyOrValue(voiceProfile.providerOptions)) return undefined;
  const text = ttsVoiceSampleText(TTS_NEUTRAL_SAMPLE_KO_V1);
  if (!text) return undefined;
  const capability =
    input.capability ??
    resolveTTSCapabilitySnapshot({
      providerId: voiceProfile.providerId,
      modelId: voiceProfile.providerModel ?? input.modelByProvider?.[voiceProfile.providerId],
      providerOptions: voiceProfile.providerOptions,
    });
  const appliedControls = projectAppliedTTSControls({
    segment: { emotion: 'neutral', confidence: 1 },
    voiceProfile,
    capability,
    userOverride: { speed: voiceProfile.speed, tone: voiceProfile.tone },
  });
  const providerOptions = cleanProviderOptions({
    ...(input.providerOptionsByProvider?.[voiceProfile.providerId] ?? {}),
    ...voiceProfile.providerOptions,
    speed: appliedControls.speed,
    pitch: appliedControls.pitch,
    tone: appliedControls.tone,
  });
  if (hasSecretLikeKeyOrValue(providerOptions)) return undefined;
  const providerModel = effectiveTTSProviderModel(
    voiceProfile.providerId,
    voiceProfile.providerModel ?? input.modelByProvider?.[voiceProfile.providerId],
  );
  const requestedFormat =
    typeof providerOptions.format === 'string' ? providerOptions.format : (capability.formats[0] ?? 'mp3');
  const format = ['mp3', 'wav', 'pcm', 'ogg', 'opus', 'aac', 'flac'].includes(requestedFormat)
    ? (requestedFormat as TTSRenderFormat)
    : 'mp3';
  const segmentId = ttsVoiceSampleSegmentId(TTS_NEUTRAL_SAMPLE_KO_V1);
  const inputTextHash = ttsInputTextIntegrityHash(text);
  const renderSpec = buildTTSRenderSpec({
    novelId: input.novelId,
    chapterId: input.chapterId,
    speakerId: voiceProfile.characterId ?? voiceProfile.role,
    voiceProfile,
    providerModel,
    segmentAnchors: [{ segmentId }],
    inputTextHash,
    providerOptionsHash: ttsProviderOptionsIntegrityHash(providerOptions),
    format,
    speed: appliedControls.speed,
    pitch: appliedControls.pitch,
    tone: appliedControls.tone,
    emotion: appliedControls.emotion,
    pronunciationRevisionId: input.pronunciationRevisionId,
    pronunciationFingerprint: input.pronunciationRevisionId,
    voiceEntryFingerprint:
      input.voiceEntryFingerprint ??
      structuredIntegrityHash({
        providerId: voiceProfile.providerId,
        modelId: providerModel ?? '',
        voiceId: voiceProfile.providerVoiceId,
      }),
    appliedControls,
    alignmentMode: 'exact_segment',
    chunkerVersion: TTS_CHUNKER_VERSION,
    synthesisProjectionVersion: TTS_SYNTHESIS_PROJECTION_VERSION,
  });
  return {
    voiceProfile,
    text,
    request: {
      providerId: voiceProfile.providerId,
      providerModel,
      voiceProfileId: voiceProfile.id,
      speakerId: voiceProfile.characterId ?? voiceProfile.role,
      segmentIds: [segmentId],
      inputTextHash,
      sampleTextId: TTS_NEUTRAL_SAMPLE_KO_V1,
      renderSpec,
      providerOptions,
      audioCharacters: text.length,
    },
  };
}

export function buildHostedTTSCacheRequest(input: HostedTTSCacheRequestInput): HostedTTSCacheRequestResult | undefined {
  const voiceProfile = input.playable.voiceProfileId
    ? input.voiceProfiles.find((profile) => profile.id === input.playable.voiceProfileId)
    : undefined;
  if (!voiceProfile || voiceProfile.providerId === 'system') return undefined;
  if (hasSecretLikeKeyOrValue(voiceProfile.providerOptions)) return undefined;
  const sourceRanges = input.playable.sourceRanges.filter(Boolean);
  if (!sourceRanges.length) return undefined;
  const segmentIds = sourceRanges.map((range) => range.segmentId).filter(Boolean);
  if (!segmentIds.length) return undefined;
  if (JSON.stringify(segmentIds) !== JSON.stringify(input.playable.sourceSegmentIds.filter(Boolean))) return undefined;

  const text = reconstructPlayableSegmentText(input.paragraph, input.segments, sourceRanges);
  if (!text || text.trim() !== (input.playable.sourceText ?? input.playable.text)) return undefined;
  const spokenText = input.playable.text;
  const capability =
    input.capability ??
    resolveTTSCapabilitySnapshot({
      providerId: voiceProfile.providerId,
      modelId: voiceProfile.providerModel ?? input.modelByProvider?.[voiceProfile.providerId],
      providerOptions: voiceProfile.providerOptions,
    });
  const appliedControls = projectAppliedTTSControls({
    segment: {
      emotion: input.playable.emotion,
      confidence: input.playable.confidence ?? 1,
      prosodyIntent: input.playable.prosodyIntent,
    },
    voiceProfile,
    capability,
    userOverride: { speed: input.playable.rate, pitch: input.pitchOverride, tone: input.playable.tone },
  });
  const providerOptions = cleanProviderOptions({
    ...(input.providerOptionsByProvider?.[voiceProfile.providerId] ?? {}),
    ...voiceProfile.providerOptions,
    speed: appliedControls.speed,
    pitch: appliedControls.pitch,
    tone: appliedControls.tone,
    emotion:
      capability.supportedControls.includes('emotion') || capability.supportedControls.includes('style')
        ? appliedControls.emotion
        : undefined,
  });
  if (hasSecretLikeKeyOrValue(providerOptions)) return undefined;
  const requestedFormat =
    typeof providerOptions.format === 'string' ? providerOptions.format : (capability.formats[0] ?? 'mp3');
  const format = ['mp3', 'wav', 'pcm', 'ogg', 'opus', 'aac', 'flac'].includes(requestedFormat)
    ? (requestedFormat as TTSRenderFormat)
    : 'mp3';
  const inputTextHash = ttsInputTextIntegrityHash(spokenText);
  const providerModel = effectiveTTSProviderModel(
    voiceProfile.providerId,
    voiceProfile.providerModel ?? input.modelByProvider?.[voiceProfile.providerId],
  );
  const renderSpec = buildTTSRenderSpec({
    novelId: input.paragraph.novelId,
    chapterId: input.paragraph.chapterId,
    contentRevision: input.contentRevision,
    chapterTextHash: input.chapterTextHash,
    speakerId: input.playable.speakerId,
    voiceProfile,
    providerModel,
    segmentAnchors: segmentAnchorsFromRanges(input.segments, sourceRanges),
    inputTextHash,
    providerOptionsHash: ttsProviderOptionsIntegrityHash(providerOptions),
    format,
    speed: appliedControls.speed,
    pitch: appliedControls.pitch,
    tone: appliedControls.tone,
    emotion: appliedControls.emotion,
    pronunciationRevisionId: input.pronunciationRevisionId,
    pronunciationFingerprint: structuredIntegrityHash({
      pronunciation: input.pronunciationFingerprint ?? '',
      spokenText: input.playable.spokenTextFingerprint ?? inputTextHash,
    }),
    voiceEntryFingerprint:
      input.voiceEntryFingerprintByVoiceId?.[voiceProfile.providerVoiceId] ??
      structuredIntegrityHash({
        providerId: voiceProfile.providerId,
        modelId: providerModel ?? '',
        voiceId: voiceProfile.providerVoiceId,
      }),
    appliedControls,
    alignmentMode:
      sourceRanges.length === 1
        ? 'exact_segment'
        : capability.timingMarks === 'none'
          ? 'estimated_chunk'
          : 'provider_marks',
    chunkerVersion: TTS_CHUNKER_VERSION,
    synthesisProjectionVersion: TTS_SYNTHESIS_PROJECTION_VERSION,
  });

  return {
    voiceProfile,
    text: spokenText,
    request: {
      providerId: voiceProfile.providerId,
      providerModel,
      voiceProfileId: voiceProfile.id,
      speakerId: input.playable.speakerId,
      segmentIds,
      inputTextHash,
      renderSpec,
      providerOptions,
      audioCharacters: spokenText.length,
    },
  };
}

export function effectiveTTSProviderModel(providerId: string, configuredModel?: string): string | undefined {
  const model = configuredModel?.trim();
  if (providerId === 'local-endpoint') return model && model !== 'endpoint-default' ? model : undefined;
  if (model) return model;
  if (providerId === 'openai-tts') return 'gpt-4o-mini-tts';
  if (providerId === 'elevenlabs') return 'eleven_flash_v2_5';
  return undefined;
}

function cleanProviderOptions(options: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== null && value !== undefined && value !== ''),
  );
}

const secretKeyPattern =
  /(api.?key|secret|token|credential|password|private.?key|authorization|bearer|client.?secret|access.?key|refresh.?token|endpoint.?url)/i;
const secretValuePattern =
  /(^sk-(?:proj-)?[A-Za-z0-9_-]{8,}|^AIza[A-Za-z0-9_-]{10,}|^ya29\.|Bearer\s+[A-Za-z0-9._~+/-]+=*|-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key"\s*:|"client_email"\s*:)/i;

function hasSecretLikeKeyOrValue(value: unknown): boolean {
  if (typeof value === 'string') return secretValuePattern.test(value.trim());
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasSecretLikeKeyOrValue);
  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) => secretKeyPattern.test(key) || hasSecretLikeKeyOrValue(item),
  );
}

function reconstructPlayableSegmentText(
  paragraph: Paragraph,
  segments: LabeledSegment[],
  sourceRanges: PlayableTtsSegment['sourceRanges'],
): string | undefined {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const parts: string[] = [];
  for (const range of sourceRanges) {
    const segment = byId.get(range.segmentId);
    if (!segment || segment.paragraphId !== paragraph.id || range.paragraphId !== paragraph.id) return undefined;
    if (
      !Number.isInteger(range.startOffset) ||
      !Number.isInteger(range.endOffset) ||
      range.startOffset < 0 ||
      range.endOffset <= range.startOffset ||
      range.endOffset > paragraph.text.length ||
      range.startOffset < segment.startOffset ||
      range.endOffset > segment.endOffset
    ) {
      return undefined;
    }
    parts.push(paragraph.text.slice(range.startOffset, range.endOffset));
  }
  return parts.join('\n');
}

function segmentAnchorsFromRanges(
  segments: LabeledSegment[],
  sourceRanges: PlayableTtsSegment['sourceRanges'],
): TTSRenderSegmentAnchor[] {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  return sourceRanges.map((range) => {
    const segment = byId.get(range.segmentId);
    return {
      segmentId: range.segmentId,
      paragraphId: range.paragraphId,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
      segmentTextHash: segment?.segmentTextHash,
    };
  });
}
