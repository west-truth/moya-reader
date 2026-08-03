import type { Character, LabeledSegment, Paragraph, SpokenTextRule, VoiceProfile } from '../domain/types';
import type { TTSCacheResolveInput } from './provider-jobs';
import { buildHostedTTSCacheRequest } from './hosted-tts-playback';
import { hostedTTSCacheRequestKey } from './hosted-tts-prefetch';
import { buildPlayableTtsSegments } from './tts-playback';
import type { TTSCapabilitySnapshot } from './provider-capability';
import type { AcceptedSpeakerProvenanceV1 } from './speaker-attribution/accepted-speaker-provenance';
import type { TtsVoiceBindingV1 } from './voice-casting';

export const DEFAULT_HOSTED_TTS_WARMUP_LIMIT = 32;
export const DEFAULT_HOSTED_TTS_BULK_WARMUP_CHAPTER_LIMIT = 3;
export const DEFAULT_HOSTED_TTS_BACKGROUND_WARMUP_CHAPTER_BATCH_LIMIT = 3;

export interface HostedTTSWarmupRequest {
  readonly requestKey: string;
  readonly chapterId: string;
  readonly paragraphId: string;
  readonly paragraphIndex: number;
  readonly speakerLabel: string;
  readonly text: string;
  readonly request: TTSCacheResolveInput;
}

export interface BuildHostedTTSWarmupRequestsInput {
  readonly chapterId: string;
  readonly paragraphs: Paragraph[];
  readonly segments: LabeledSegment[];
  readonly characters: Character[];
  readonly voiceProfiles: VoiceProfile[];
  readonly fallbackVoiceURI?: string;
  readonly baseRate: number;
  readonly maxRequests?: number;
  readonly contentRevision?: string;
  readonly chapterTextHash?: string;
  readonly providerOptionsByProvider?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly modelByProvider?: Readonly<Record<string, string>>;
  readonly pronunciationRevisionId?: string;
  readonly pronunciationFingerprint?: string;
  readonly capability?: TTSCapabilitySnapshot;
  readonly voiceEntryFingerprintByVoiceId?: Readonly<Record<string, string>>;
  readonly acceptedSpeakerProvenance?: readonly AcceptedSpeakerProvenanceV1[];
  readonly voiceBindings?: readonly TtsVoiceBindingV1[];
  readonly language?: string;
  readonly spokenTextRules?: readonly SpokenTextRule[];
  readonly rubyPolicy?: 'base' | 'reading';
  readonly footnotePolicy?: 'skip_marker' | 'read_marker';
}

export interface HostedTTSWarmupChapterSource {
  readonly chapterId: string;
  readonly chapterTextHash?: string;
  readonly paragraphs: Paragraph[];
  readonly segments: LabeledSegment[];
  readonly acceptedSpeakerProvenance?: readonly AcceptedSpeakerProvenanceV1[];
  readonly voiceBindings?: readonly TtsVoiceBindingV1[];
}

export interface BuildHostedTTSBulkWarmupRequestsInput {
  readonly chapters: HostedTTSWarmupChapterSource[];
  readonly characters: Character[];
  readonly voiceProfiles: VoiceProfile[];
  readonly fallbackVoiceURI?: string;
  readonly baseRate: number;
  readonly maxRequests?: number;
  readonly contentRevision?: string;
  readonly providerOptionsByProvider?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly modelByProvider?: Readonly<Record<string, string>>;
  readonly pronunciationRevisionId?: string;
  readonly pronunciationFingerprint?: string;
  readonly capability?: TTSCapabilitySnapshot;
  readonly voiceEntryFingerprintByVoiceId?: Readonly<Record<string, string>>;
  readonly language?: string;
  readonly spokenTextRules?: readonly SpokenTextRule[];
  readonly rubyPolicy?: 'base' | 'reading';
  readonly footnotePolicy?: 'skip_marker' | 'read_marker';
}

export function buildHostedTTSWarmupRequests(input: BuildHostedTTSWarmupRequestsInput): HostedTTSWarmupRequest[] {
  const maxRequests = Math.max(0, input.maxRequests ?? DEFAULT_HOSTED_TTS_WARMUP_LIMIT);
  if (maxRequests === 0) return [];

  const seen = new Set<string>();
  const requests: HostedTTSWarmupRequest[] = [];
  const chapterSegments = input.segments.filter((segment) => segment.chapterId === input.chapterId);
  const segmentsByParagraph = new Map<string, LabeledSegment[]>();
  for (const segment of chapterSegments) {
    const paragraphSegments = segmentsByParagraph.get(segment.paragraphId);
    if (paragraphSegments) paragraphSegments.push(segment);
    else segmentsByParagraph.set(segment.paragraphId, [segment]);
  }
  const paragraphs = input.paragraphs
    .filter((paragraph) => paragraph.chapterId === input.chapterId)
    .sort((a, b) => a.index - b.index);
  for (const paragraph of paragraphs) {
    const paragraphSegments = segmentsByParagraph.get(paragraph.id) ?? [];
    const playableSegments = buildPlayableTtsSegments({
      paragraph,
      segments: paragraphSegments,
      characters: input.characters,
      voiceProfiles: input.voiceProfiles,
      fallbackVoiceURI: input.fallbackVoiceURI,
      baseRate: input.baseRate,
      acceptedSpeakerProvenance: input.acceptedSpeakerProvenance,
      voiceBindings: input.voiceBindings,
      language: input.language,
      spokenTextRules: input.spokenTextRules,
      rubyPolicy: input.rubyPolicy,
      footnotePolicy: input.footnotePolicy,
    });
    for (const playable of playableSegments) {
      const cacheRequest = buildHostedTTSCacheRequest({
        paragraph,
        playable,
        segments: paragraphSegments,
        voiceProfiles: input.voiceProfiles,
        contentRevision: input.contentRevision,
        chapterTextHash: input.chapterTextHash,
        providerOptionsByProvider: input.providerOptionsByProvider,
        modelByProvider: input.modelByProvider,
        pronunciationRevisionId: input.pronunciationRevisionId,
        pronunciationFingerprint: input.pronunciationFingerprint,
        capability: input.capability,
        voiceEntryFingerprintByVoiceId: input.voiceEntryFingerprintByVoiceId,
      });
      if (!cacheRequest) continue;
      const requestKey = hostedTTSCacheRequestKey(input.chapterId, cacheRequest.request);
      if (seen.has(requestKey)) continue;
      seen.add(requestKey);
      requests.push({
        requestKey,
        chapterId: input.chapterId,
        paragraphId: paragraph.id,
        paragraphIndex: paragraph.index,
        speakerLabel: playable.speakerLabel,
        text: cacheRequest.text,
        request: cacheRequest.request,
      });
      if (requests.length >= maxRequests) return requests;
    }
  }
  return requests;
}

export function buildHostedTTSBulkWarmupRequests(
  input: BuildHostedTTSBulkWarmupRequestsInput,
): HostedTTSWarmupRequest[] {
  const maxRequests = Math.max(0, input.maxRequests ?? DEFAULT_HOSTED_TTS_WARMUP_LIMIT);
  if (maxRequests === 0) return [];

  const requests: HostedTTSWarmupRequest[] = [];
  const seen = new Set<string>();
  for (const chapter of input.chapters) {
    if (requests.length >= maxRequests) break;
    const chapterRequests = buildHostedTTSWarmupRequests({
      chapterId: chapter.chapterId,
      paragraphs: chapter.paragraphs,
      segments: chapter.segments,
      characters: input.characters,
      voiceProfiles: input.voiceProfiles,
      fallbackVoiceURI: input.fallbackVoiceURI,
      baseRate: input.baseRate,
      maxRequests: maxRequests - requests.length,
      contentRevision: input.contentRevision,
      chapterTextHash: chapter.chapterTextHash,
      providerOptionsByProvider: input.providerOptionsByProvider,
      modelByProvider: input.modelByProvider,
      pronunciationRevisionId: input.pronunciationRevisionId,
      pronunciationFingerprint: input.pronunciationFingerprint,
      capability: input.capability,
      voiceEntryFingerprintByVoiceId: input.voiceEntryFingerprintByVoiceId,
      acceptedSpeakerProvenance: chapter.acceptedSpeakerProvenance,
      voiceBindings: chapter.voiceBindings,
      language: input.language,
      spokenTextRules: input.spokenTextRules,
      rubyPolicy: input.rubyPolicy,
      footnotePolicy: input.footnotePolicy,
    });
    for (const request of chapterRequests) {
      if (seen.has(request.requestKey)) continue;
      seen.add(request.requestKey);
      requests.push(request);
      if (requests.length >= maxRequests) break;
    }
  }
  return requests;
}
