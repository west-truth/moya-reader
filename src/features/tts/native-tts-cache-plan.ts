import type { Chapter, Character, LabeledSegment, Paragraph, SpokenTextRule, VoiceProfile } from '../../domain/types';
import { buildHostedTTSBulkWarmupRequests } from '../../providers/hosted-tts-warmup';
import type { ReaderRepository } from '../../repositories/reader-repository';
import type { TTSCacheGateway, TTSNativeRecoveryPolicy } from './tts-cache-gateway';
import type { TTSCapabilitySnapshot } from '../../providers/provider-capability';
import { inspectNativeTTSCache, runNativeTTSWarmup, type NativeTTSWarmupSummary } from './native-tts-warmup-runner';
import { loadTTSWarmupChapterSource } from './tts-warmup-plan';
import type { TtsVoiceBindingV1 } from '../../providers/voice-casting';
import type { NativeTTSWarmupObserver } from './native-tts-warmup-runner';

export interface NativeTTSCachePlanInput {
  readonly mode: 'inspect' | 'render';
  readonly novelId: string;
  readonly contentRevision: string;
  readonly chapters: readonly Chapter[];
  readonly currentChapterId?: string;
  readonly currentSegments: readonly LabeledSegment[];
  readonly characters: readonly Character[];
  readonly voiceProfiles: readonly VoiceProfile[];
  readonly fallbackVoiceURI?: string;
  readonly baseRate: number;
  readonly providerOptionsByProvider?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly modelByProvider?: Readonly<Record<string, string>>;
  readonly pronunciationRevisionId?: string;
  readonly capability?: TTSCapabilitySnapshot;
  readonly voiceEntryFingerprintByVoiceId?: Readonly<Record<string, string>>;
  readonly language?: string;
  readonly spokenTextRules?: readonly SpokenTextRule[];
  readonly loadVoiceBindings: (chapterId: string) => Promise<readonly TtsVoiceBindingV1[]>;
  readonly repository: ReaderRepository;
  readonly gateway: TTSCacheGateway;
  readonly signal: AbortSignal;
  readonly maxRequests: number;
  readonly maxCandidateParagraphs: number;
  readonly cachedParagraph?: (paragraphId: string) => Paragraph | undefined;
  readonly onStatus?: (status: string) => void;
  readonly observer?: NativeTTSWarmupObserver;
  readonly retryLimit?: number;
  readonly recoveryPolicy?: TTSNativeRecoveryPolicy;
}

export function runNativeTTSCachePlan(input: NativeTTSCachePlanInput): Promise<NativeTTSWarmupSummary> {
  const run = input.mode === 'inspect' ? inspectNativeTTSCache : runNativeTTSWarmup;
  return run({
    novelId: input.novelId,
    contentRevision: input.contentRevision,
    chapters: input.chapters,
    signal: input.signal,
    gateway: input.gateway,
    loadChapterSource: async (chapter, signal) => {
      const [source, voiceBindings] = await Promise.all([
        loadTTSWarmupChapterSource({
          repository: input.repository,
          chapter,
          currentChapterId: input.currentChapterId,
          currentSegments: input.currentSegments,
          cachedParagraph: input.cachedParagraph,
          maxCandidateParagraphs: input.maxCandidateParagraphs,
          signal,
        }),
        input.loadVoiceBindings(chapter.id),
      ]);
      return source
        ? {
            ...source,
            voiceBindings,
          }
        : undefined;
    },
    buildRequests: (chapterSources) =>
      buildHostedTTSBulkWarmupRequests({
        chapters: chapterSources,
        characters: [...input.characters],
        voiceProfiles: [...input.voiceProfiles],
        fallbackVoiceURI: input.fallbackVoiceURI,
        baseRate: input.baseRate,
        maxRequests: input.maxRequests,
        contentRevision: input.contentRevision,
        providerOptionsByProvider: input.providerOptionsByProvider,
        modelByProvider: input.modelByProvider,
        pronunciationRevisionId: input.pronunciationRevisionId,
        pronunciationFingerprint: input.pronunciationRevisionId,
        capability: input.capability,
        voiceEntryFingerprintByVoiceId: input.voiceEntryFingerprintByVoiceId,
        language: input.language,
        spokenTextRules: input.spokenTextRules,
        rubyPolicy: 'reading',
        footnotePolicy: 'skip_marker',
      }),
    onStatus: input.onStatus,
    observer: input.observer,
    retryLimit: input.retryLimit,
    recoveryPolicy: input.recoveryPolicy,
  });
}
