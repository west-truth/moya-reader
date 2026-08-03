import type {
  Chapter,
  Character,
  LabeledSegment,
  Novel,
  Paragraph,
  SpokenTextRule,
  VoiceProfile,
} from '../../domain/types';
import type { BookAnalysisWorkflow } from '../ai/book-analysis-workflow-gateway';
import type { ReaderRepository } from '../../repositories/reader-repository';
import type { JsonValue } from '../../sync/types';
import type { NativeTTSWarmupSummary } from './native-tts-warmup-runner';
import type { TTSCacheGateway, TTSNativeRecoveryPolicy } from './tts-cache-gateway';
import type { TTSCapabilitySnapshot } from '../../providers/provider-capability';
import type { TtsVoiceBindingV1 } from '../../providers/voice-casting';
import type { NativeTTSWarmupObserver } from './native-tts-warmup-runner';

export interface NativeTTSCacheControllerInput {
  readonly enabled: boolean;
  readonly gateway?: TTSCacheGateway;
  readonly novel?: Novel;
  readonly chapters: readonly Chapter[];
  readonly currentChapter?: Chapter;
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
  readonly spokenTextRules?: readonly SpokenTextRule[];
  readonly loadVoiceBindings: (chapterId: string) => Promise<readonly TtsVoiceBindingV1[]>;
  readonly repository: ReaderRepository;
  readonly cachedParagraph?: (paragraphId: string) => Paragraph | undefined;
  readonly workflow?: BookAnalysisWorkflow;
  readonly labelVoiceReady: boolean;
  readonly adoptWorkflow: (workflow: BookAnalysisWorkflow, options?: { confirmsTTSReadiness?: boolean }) => boolean;
  readonly notify: (message: string, tone: 'warning' | 'success') => void;
}

export interface NativeTTSCacheRunOptions {
  readonly fullScan?: boolean;
  readonly onStatus?: (status: string) => void;
  readonly observer?: NativeTTSWarmupObserver;
  readonly retryLimit?: number;
  readonly recoveryPolicy?: TTSNativeRecoveryPolicy;
}

export type NativeTTSCacheRuntimeContext = readonly [boolean, TTSCacheGateway | undefined];
export type NativeTTSCacheBookContext = readonly [
  Novel | undefined,
  readonly Chapter[],
  Chapter | undefined,
  readonly LabeledSegment[],
  readonly Character[],
  ReaderRepository,
  ((paragraphId: string) => Paragraph | undefined) | undefined,
];
export type NativeTTSCacheVoiceContext = readonly [
  readonly VoiceProfile[],
  string | undefined,
  number,
  Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
  Readonly<Record<string, string>> | undefined,
  string | undefined,
  TTSCapabilitySnapshot | undefined,
  Readonly<Record<string, string>> | undefined,
  ((chapterId: string) => Promise<readonly TtsVoiceBindingV1[]>)?,
  (readonly SpokenTextRule[] | undefined)?,
];
export type NativeTTSCacheLifecycleContext = readonly [
  BookAnalysisWorkflow | undefined,
  boolean,
  NativeTTSCacheControllerInput['adoptWorkflow'],
  NativeTTSCacheControllerInput['notify'],
];

export function createNativeTTSCacheControllerInput(
  runtime: NativeTTSCacheRuntimeContext,
  book: NativeTTSCacheBookContext,
  voice: NativeTTSCacheVoiceContext,
  lifecycle: NativeTTSCacheLifecycleContext,
): NativeTTSCacheControllerInput {
  return {
    enabled: runtime[0],
    gateway: runtime[1],
    novel: book[0],
    chapters: book[1],
    currentChapter: book[2],
    currentSegments: book[3],
    characters: book[4],
    repository: book[5],
    cachedParagraph: book[6],
    voiceProfiles: voice[0],
    fallbackVoiceURI: voice[1],
    baseRate: voice[2],
    providerOptionsByProvider: voice[3],
    modelByProvider: voice[4],
    pronunciationRevisionId: voice[5],
    capability: voice[6],
    voiceEntryFingerprintByVoiceId: voice[7],
    loadVoiceBindings: voice[8] ?? (() => Promise.resolve([])),
    spokenTextRules: voice[9],
    workflow: lifecycle[0],
    labelVoiceReady: lifecycle[1],
    adoptWorkflow: lifecycle[2],
    notify: lifecycle[3],
  };
}

function progressRecord(progress: JsonValue | undefined): Record<string, JsonValue> {
  return progress && typeof progress === 'object' && !Array.isArray(progress)
    ? (progress as Record<string, JsonValue>)
    : {};
}

function readinessValue(readiness: NativeTTSWarmupSummary['readiness']): JsonValue {
  if (!readiness) return null;
  return {
    ...readiness,
    readyRenderSpecHashes: [...readiness.readyRenderSpecHashes],
    missingRenderSpecHashes: [...readiness.missingRenderSpecHashes],
  };
}

export function applyNativeTTSCacheReadiness(
  input: NativeTTSCacheControllerInput,
  next: NonNullable<NativeTTSWarmupSummary['readiness']>,
) {
  if (!input.workflow) return;
  const previous = progressRecord(input.workflow.progress).ttsCacheReadiness;
  if (progressRecord(previous).evidenceHash === next.evidenceHash) return;
  input.adoptWorkflow(
    {
      ...input.workflow,
      stage: next.ok
        ? 'audio_cache_ready'
        : input.workflow.stage === 'audio_cache_ready'
          ? 'ready_for_tts'
          : input.workflow.stage,
      progress: {
        ...progressRecord(input.workflow.progress),
        ttsCacheReadiness: readinessValue(next),
      },
    },
    { confirmsTTSReadiness: true },
  );
}

const refreshControllers = new WeakMap<TTSCacheGateway, AbortController>();

export async function refreshNativeTTSCacheReadiness(
  input: NativeTTSCacheControllerInput,
  options: { silent?: boolean } = {},
) {
  if (!input.gateway || !input.workflow) return undefined;
  refreshControllers.get(input.gateway)?.abort();
  const controller = new AbortController();
  refreshControllers.set(input.gateway, controller);
  const plannedIds = new Set(input.workflow.plan.ttsReady.chapterIds);
  const chapters =
    plannedIds.size > 0 ? input.chapters.filter((chapter) => plannedIds.has(chapter.id)) : input.chapters;
  try {
    const summary = await runNativeTTSCacheOperation(input, 'inspect', chapters, controller.signal, { fullScan: true });
    if (!summary || controller.signal.aborted) return undefined;
    if (summary.sourceFailures > 0 || !summary.readiness) {
      if (!options.silent) input.notify('TTS cache 원문 또는 라벨을 모두 확인하지 못했습니다.', 'warning');
      return summary;
    }
    applyNativeTTSCacheReadiness(input, summary.readiness);
    if (!options.silent) {
      input.notify(
        summary.readiness.ok ? 'TTS 오디오 cache 준비 상태가 확인되었습니다.' : 'TTS cache가 아직 부족합니다.',
        summary.readiness.ok ? 'success' : 'warning',
      );
    }
    return summary;
  } catch (error) {
    if (!controller.signal.aborted && !options.silent) {
      input.notify(`TTS 오디오 cache 상태 확인 실패: ${String(error)}`, 'warning');
    }
    return undefined;
  } finally {
    if (refreshControllers.get(input.gateway) === controller) refreshControllers.delete(input.gateway);
  }
}

export async function runNativeTTSCacheOperation(
  input: NativeTTSCacheControllerInput,
  mode: 'inspect' | 'render',
  sourceChapters: readonly Chapter[],
  signal: AbortSignal,
  options: NativeTTSCacheRunOptions = {},
): Promise<NativeTTSWarmupSummary | undefined> {
  const contentRevision = input.novel?.activeContentRevisionId;
  if (!input.gateway || !input.novel || !contentRevision) return undefined;
  const fullScan = mode === 'inspect' || options.fullScan;
  const { runNativeTTSCachePlan } = await import('./native-tts-cache-plan');
  const summary = await runNativeTTSCachePlan({
    mode,
    novelId: input.novel.id,
    contentRevision,
    chapters: sourceChapters,
    currentChapterId: input.currentChapter?.id,
    currentSegments: input.currentSegments,
    characters: input.characters,
    voiceProfiles: input.voiceProfiles,
    fallbackVoiceURI: input.fallbackVoiceURI,
    baseRate: input.baseRate,
    providerOptionsByProvider: input.providerOptionsByProvider,
    modelByProvider: input.modelByProvider,
    pronunciationRevisionId: input.pronunciationRevisionId,
    capability: input.capability,
    voiceEntryFingerprintByVoiceId: input.voiceEntryFingerprintByVoiceId,
    language: input.novel.language,
    spokenTextRules: input.spokenTextRules,
    loadVoiceBindings: input.loadVoiceBindings,
    repository: input.repository,
    gateway: input.gateway,
    signal,
    maxRequests: fullScan ? Number.POSITIVE_INFINITY : 32,
    maxCandidateParagraphs: fullScan ? Number.POSITIVE_INFINITY : 32,
    cachedParagraph: input.cachedParagraph,
    onStatus: options.onStatus,
    observer: options.observer,
    retryLimit: options.retryLimit,
    recoveryPolicy: options.recoveryPolicy,
  });
  if (shouldApplyNativeTTSReadiness(mode, options, summary)) {
    applyNativeTTSCacheReadiness(input, summary.readiness!);
  }
  return summary;
}

export function shouldApplyNativeTTSReadiness(
  mode: 'inspect' | 'render',
  options: NativeTTSCacheRunOptions,
  summary: NativeTTSWarmupSummary,
): boolean {
  return (
    mode === 'render' &&
    options.fullScan === true &&
    Boolean(summary.readiness) &&
    summary.failed === 0 &&
    summary.sourceFailures === 0 &&
    !summary.aborted
  );
}
