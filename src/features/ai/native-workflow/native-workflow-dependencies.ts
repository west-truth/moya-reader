import { textIntegrityHash } from '@noveldesk/text-core/hash';
import type { LockedSpeakerSpanV1, SpeakerSpanType } from '@noveldesk/text-core/speaker-attribution';
import type { BookContentRevisionHandle } from '../../../storage/content-revision-read-handle';
import type {
  NativeAnalysisWorkflowRepository,
  RevisionPinnedReaderRepository,
} from '../../../repositories/reader-repository';
import type {
  NativeAnalysisProviderDescriptor,
  NativeLabelingContract,
} from '../../../storage/native-analysis-workflow';
import type {
  CharacterBundleAnalysisResult,
  CharacterGraph,
  ChapterLabelingResult,
  LabelChapterSegmentsInput,
  MergeCharacterGraphInput,
} from '../../../providers/ai';
import {
  planBookAIWorkflow,
  type BookAIWorkflowLabelingWindow,
  type BookAIWorkflowPlan,
  type BookAIWorkflowPlanOptions,
} from '../../../providers/book-ai-workflow-plan';
import {
  characterBundleResponseToResult,
  parseCharacterBundleResponse,
} from '../../../providers/character-bundle-contract';
import { buildCharacterBundleAnalysisRequest } from '../../../providers/character-bundle-request-profile';
import {
  characterGraphResponseToGraph,
  parseCharacterGraphResponse,
} from '../../../providers/character-graph-contract';
import { buildCharacterGraphMergeRequest } from '../../../providers/character-graph-request-profile';
import {
  buildChapterLabelingRequest,
  resolveChapterLabelingRequestProfile,
} from '../../../providers/chapter-labeling-request-profile';
import {
  assertLabelingContextPacketAdmitted,
  buildLabelingContextPacket,
} from '../../../providers/labeling-context-packet';
import type { LabeledSegment, Paragraph } from '../../../domain/types';
import {
  backfillCharacterGraphKnowledgeV2,
  type CharacterGraphKnowledgeV2,
} from '../../../providers/character-graph-v2';
import { resolveLabelingContextCapability } from '../../../providers/labeling-context-packet';
import {
  materializeSpeakerAttributionInput,
  prepareSpeakerAttributionInputMaterialization,
  type MaterializedSpeakerAttributionInput,
  type SpeakerAttributionInputMaterializerSource,
} from '../../../providers/speaker-attribution/input-materializer';
import {
  getSpeakerSourceManifest,
  replaceSpeakerAttributionChapterInventory,
} from '../../../storage/speaker-attribution-store';
import {
  appendTemporalAddressUseEvents,
  listTemporalAddressUseEvents,
  listTemporalRelationEdges,
  replaceCharacterTemporalSnapshotsForChapter,
} from '../../../storage/temporal-character-memory-store';
import type {
  NativeBookWorkflowMaterializeRequest,
  NativeBookWorkflowView,
  NativeStructuredJsonBatch,
  NativeStructuredJsonRequest,
  NativeWorkflowCheckpointResult,
} from './contracts';
import {
  previousEpisodeContext,
  type NativeBundleSource,
  type NativeGraphMergeSource,
  type NativeLabelingSource,
  type NativeWorkflowMaterializationLoaders,
  type NativeWorkflowRequestBuilders,
} from './orchestrator';
import { assertNativeLabelingContractExecutable, pinnedRichLabelingProviderOptions } from './labeling-contract';
import {
  aggregateNativeSpeakerBatchCheckpoint,
  type NativeSpeakerBatchAggregation,
} from './native-speaker-batch-aggregator';
import { buildNativeSpeakerBatchMaterializeRequest } from './native-speaker-batch-materializer';

export type NativeWorkflowReaderRepository = RevisionPinnedReaderRepository & NativeAnalysisWorkflowRepository;

function abortError(): DOMException {
  return new DOMException('Native workflow source read aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function yieldToBrowser(): Promise<void> {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
}

export async function planPinnedNativeBookWorkflow(input: {
  readonly source: BookContentRevisionHandle;
  readonly options?: BookAIWorkflowPlanOptions;
  readonly provider?: NativeAnalysisProviderDescriptor;
  readonly signal?: AbortSignal;
}): Promise<BookAIWorkflowPlan> {
  const chapters = await input.source.listChapters();
  const paragraphs: Array<Pick<Paragraph, 'id' | 'chapterId' | 'index' | 'textHash'> & { length: number }> = [];
  for (const chapter of chapters) {
    throwIfAborted(input.signal);
    const signal = input.signal ?? new AbortController().signal;
    for await (const page of input.source.iterateParagraphPages({ chapterId: chapter.id, signal, batchSize: 20 })) {
      for (const paragraph of page.paragraphs) {
        paragraphs.push({
          id: paragraph.id,
          chapterId: paragraph.chapterId,
          index: paragraph.index,
          textHash: paragraph.textHash,
          length: paragraph.text.length,
        });
      }
    }
    await yieldToBrowser();
  }
  throwIfAborted(input.signal);
  return planBookAIWorkflow({
    novelId: input.source.novel.id,
    chapters,
    paragraphs,
    options: input.options,
    labelingCapability: input.provider
      ? resolveLabelingContextCapability({
          providerId: input.provider.providerId,
          modelId: input.provider.modelId,
          providerOptions: input.provider.providerOptions,
        })
      : undefined,
  });
}

function nativeRequest(
  provider: NativeAnalysisProviderDescriptor,
  request: {
    readonly prompt: string;
    readonly responseSchema: unknown;
    readonly jsonSchemaName: string;
    readonly providerOptions: Record<string, unknown>;
    readonly profile?: { readonly schemaVersion: string };
  },
): NativeStructuredJsonRequest {
  return {
    providerId: provider.providerId,
    modelId: provider.modelId,
    prompt: request.prompt,
    responseSchema: request.responseSchema,
    jsonSchemaName: request.jsonSchemaName,
    schemaVersion: request.profile?.schemaVersion,
    providerOptions: request.providerOptions,
  };
}

const speakerSpanType: Readonly<Record<LabeledSegment['type'], SpeakerSpanType>> = {
  narration: 'narration',
  quoted_dialogue: 'dialogue',
  plain_dialogue: 'message',
  inner_monologue: 'inner_monologue',
  system_message: 'system',
  sfx: 'sfx',
  author_note: 'metadata',
  unknown: 'unknown',
};

interface NativeCompactSpeakerMaterialization extends MaterializedSpeakerAttributionInput {
  readonly source: SpeakerAttributionInputMaterializerSource;
  readonly batch: NativeStructuredJsonBatch;
  readonly request: NativeBookWorkflowMaterializeRequest & {
    readonly request?: never;
    readonly batch: NativeStructuredJsonBatch;
  };
}

export interface NativeCompactSpeakerCheckpoint {
  readonly source: NativeLabelingSource;
  readonly materialization: NativeCompactSpeakerMaterialization;
  readonly aggregation: NativeSpeakerBatchAggregation;
}

export function parseNativeLabelingCheckpoint(input: {
  readonly output: unknown;
  readonly providerOptions: Readonly<Record<string, unknown>>;
  readonly labelingContract?: NativeLabelingContract;
  readonly labelingInput: LabelChapterSegmentsInput;
}): ChapterLabelingResult {
  const profile = resolveChapterLabelingRequestProfile(
    pinnedRichLabelingProviderOptions(input.providerOptions, input.labelingContract),
  );
  const response = profile.parseResponse(JSON.stringify(input.output));
  return profile.toResult(input.labelingInput, response);
}

export class NativeWorkflowDependencyFactory {
  private readonly paragraphCache = new Map<string, Promise<Paragraph[]>>();
  private readonly chapterCache = new Map<
    string,
    Awaited<ReturnType<BookContentRevisionHandle['listChapters']>>[number]
  >();
  private readonly bundleCheckpointCache = new Map<string, Promise<CharacterBundleAnalysisResult>>();
  private graphCheckpointCache?: Promise<CharacterGraph>;
  private readonly labelingCheckpointCache = new Map<string, Promise<ChapterLabelingResult>>();
  private readonly compactMaterializationCache = new Map<string, Promise<NativeCompactSpeakerMaterialization>>();
  private readonly compactCheckpointCache = new Map<string, Promise<NativeCompactSpeakerCheckpoint>>();
  private graphKnowledge?: CharacterGraphKnowledgeV2;
  private workflow?: NativeBookWorkflowView;

  readonly loaders: NativeWorkflowMaterializationLoaders;
  readonly builders: NativeWorkflowRequestBuilders;

  constructor(
    private readonly source: BookContentRevisionHandle,
    private readonly repository: NativeWorkflowReaderRepository,
    private readonly plan: BookAIWorkflowPlan,
    private readonly provider: NativeAnalysisProviderDescriptor,
    private readonly labelingContract?: NativeLabelingContract,
  ) {
    assertNativeLabelingContractExecutable(this.labelingContract);
    this.loaders = {
      loadBundleSource: (window) => this.loadBundleSource(window.chapterIds),
      loadGraphMergeSource: () => this.loadGraphMergeSource(),
      loadLabelingSource: (window) => this.loadLabelingSource(window),
      loadBundleCheckpoint: (checkpoint, window) => this.loadBundleCheckpoint(checkpoint, window.id),
      loadGraphCheckpoint: (checkpoint) => this.loadGraphCheckpoint(checkpoint),
      loadLabelingCheckpoint: (checkpoint, window) => this.loadLabelingCheckpoint(checkpoint, window.id),
    };
    this.builders = {
      buildBundleRequest: (input) =>
        nativeRequest(this.provider, buildCharacterBundleAnalysisRequest(input, { ...this.provider.providerOptions })),
      buildGraphMergeRequest: (input) =>
        nativeRequest(this.provider, buildCharacterGraphMergeRequest(input, { ...this.provider.providerOptions })),
      buildLabelingRequest: (input) => {
        const providerOptions = pinnedRichLabelingProviderOptions(this.provider.providerOptions, this.labelingContract);
        const profile = resolveChapterLabelingRequestProfile(providerOptions);
        const contextPacket =
          input.contextPacket ??
          buildLabelingContextPacket({
            novelId: input.novelId,
            chapterId: input.chapter.id,
            targetParagraphs: input.paragraphs,
            haloParagraphs: input.contextHaloParagraphs,
            characterGraph: input.characterGraph ?? {
              novelId: input.novelId,
              characters: input.knownCharacters ?? [],
              relations: [],
            },
            characterGraphKnowledge: this.graphKnowledge,
            chapterIndex: input.chapter.index,
            previousEpisodeContext: input.previousEpisodeContext,
            corrections: input.userCorrections,
            providerId: this.provider.providerId,
            modelId: this.provider.modelId,
            providerOptions,
            schemaCharacters: JSON.stringify(profile.responseSchema).length,
          });
        assertLabelingContextPacketAdmitted(contextPacket);
        return nativeRequest(this.provider, buildChapterLabelingRequest({ ...input, contextPacket }, providerOptions));
      },
    };
  }

  async initialize(): Promise<void> {
    const [chapters, graphKnowledge] = await Promise.all([
      this.source.listChapters(),
      typeof this.repository.getCharacterGraphKnowledgeV2 === 'function'
        ? this.repository.getCharacterGraphKnowledgeV2(this.plan.novelId)
        : undefined,
    ]);
    this.graphKnowledge = graphKnowledge;
    for (const chapter of chapters) this.chapterCache.set(chapter.id, chapter);
  }

  setWorkflow(workflow: NativeBookWorkflowView): void {
    this.workflow = workflow;
  }

  private async paragraphs(chapterId: string): Promise<Paragraph[]> {
    let pending = this.paragraphCache.get(chapterId);
    if (!pending) {
      pending = this.source.listParagraphs(chapterId);
      this.paragraphCache.set(chapterId, pending);
    }
    return pending;
  }

  private chapter(chapterId: string) {
    const chapter = this.chapterCache.get(chapterId);
    if (!chapter) throw new Error(`Pinned native workflow chapter not found: ${chapterId}`);
    return chapter;
  }

  private async graph(): Promise<CharacterGraph> {
    const [characters, relations] = await Promise.all([
      this.repository.listCharacters(this.plan.novelId),
      this.repository.listCharacterRelations(this.plan.novelId),
    ]);
    return { novelId: this.plan.novelId, characters, relations };
  }

  private async loadBundleSource(chapterIds: readonly string[]): Promise<NativeBundleSource> {
    const [chapters, existingGraph, userCorrections] = await Promise.all([
      Promise.all(
        chapterIds.map(async (chapterId) => ({
          chapter: this.chapter(chapterId),
          paragraphs: await this.paragraphs(chapterId),
        })),
      ),
      this.graph(),
      this.repository.listCorrections(this.plan.novelId),
    ]);
    return { chapters, existingGraph, userCorrections };
  }

  private async loadGraphMergeSource(): Promise<NativeGraphMergeSource> {
    const [existingGraph, userCorrections] = await Promise.all([
      this.graph(),
      this.repository.listCorrections(this.plan.novelId),
    ]);
    return { existingGraph, userCorrections };
  }

  private async loadLabelingSource(window: BookAIWorkflowLabelingWindow): Promise<NativeLabelingSource> {
    const { chapterId, paragraphIds } = window;
    const [allParagraphs, knownCharacters, userCorrections] = await Promise.all([
      this.paragraphs(chapterId),
      this.repository.listCharacters(this.plan.novelId),
      this.repository.listCorrections(this.plan.novelId, chapterId),
    ]);
    const planned = new Set(paragraphIds);
    const paragraphs =
      paragraphIds.length > 0 ? allParagraphs.filter((paragraph) => planned.has(paragraph.id)) : allParagraphs;
    if (paragraphIds.length > 0 && paragraphs.length !== paragraphIds.length) {
      throw new Error(`Pinned native workflow paragraph plan drifted for chapter ${chapterId}`);
    }
    const radiusValue = this.provider.providerOptions.contextHaloParagraphs;
    const parsedRadius =
      typeof radiusValue === 'number' ? radiusValue : typeof radiusValue === 'string' ? Number(radiusValue) : 2;
    const radius = Number.isFinite(parsedRadius) ? Math.min(8, Math.max(0, Math.floor(parsedRadius))) : 2;
    const haloParagraphs = allParagraphs.filter(
      (paragraph) =>
        paragraph.index >= Math.max(0, window.startParagraphIndex - radius) &&
        paragraph.index <= window.endParagraphIndex + radius &&
        (paragraph.index < window.startParagraphIndex || paragraph.index > window.endParagraphIndex),
    );
    return { chapter: this.chapter(chapterId), paragraphs, knownCharacters, userCorrections, haloParagraphs };
  }

  private async lockedSpeakerSpans(
    chapterId: string,
    paragraphs: readonly Paragraph[],
  ): Promise<LockedSpeakerSpanV1[]> {
    const paragraphTextById = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph.text]));
    const segments = await this.repository.listSegments(chapterId);
    return segments.flatMap((segment) => {
      if (!segment.isUserCorrected) return [];
      const text = paragraphTextById.get(segment.paragraphId);
      if (
        text === undefined ||
        segment.startOffset < 0 ||
        segment.endOffset <= segment.startOffset ||
        segment.endOffset > text.length
      ) {
        return [];
      }
      return [
        {
          paragraphId: segment.paragraphId,
          startOffset: segment.startOffset,
          endOffset: segment.endOffset,
          textHash: textIntegrityHash(text.slice(segment.startOffset, segment.endOffset)),
          type: speakerSpanType[segment.type],
          speakerId: segment.speakerId,
          correctionId: segment.id,
        },
      ];
    });
  }

  private async compactPreviousContext(
    window: BookAIWorkflowLabelingWindow,
  ): Promise<LabelChapterSegmentsInput['previousEpisodeContext']> {
    const windowIndex = this.plan.labelingWindows.findIndex((candidate) => candidate.id === window.id);
    for (let index = windowIndex - 1; index >= 0; index -= 1) {
      const previousWindow = this.plan.labelingWindows[index]!;
      const previousCheckpoint = this.currentCheckpoints.get(previousWindow.id);
      if (!previousCheckpoint) throw new Error(`Previous native labeling checkpoint is missing: ${previousWindow.id}`);
      const previousResult =
        (await this.promotedLabelingResult(previousWindow.id)) ??
        (await this.loadLabelingCheckpoint(previousCheckpoint, previousWindow.id));
      const previousSource = await this.loadLabelingSource(previousWindow);
      const context = previousEpisodeContext(previousResult, previousSource.paragraphs, previousWindow.id, true);
      if (context) return context;
    }
    return undefined;
  }

  private async promotedLabelingResult(windowId: string): Promise<ChapterLabelingResult | undefined> {
    if (!this.workflow) return undefined;
    const artifacts = await this.repository.listNativeAnalysisStagedOutputs(this.workflow.id);
    const artifact = artifacts.find(
      (candidate) =>
        candidate.jobId === windowId &&
        candidate.status === 'promoted' &&
        candidate.payload.kind === 'label_window' &&
        Boolean(candidate.payload.result),
    );
    if (!artifact || artifact.payload.kind !== 'label_window') return undefined;
    return artifact.reviewDraft ?? artifact.payload.result;
  }

  private async compactSpeakerSource(window: BookAIWorkflowLabelingWindow): Promise<{
    readonly labelingSource: NativeLabelingSource;
    readonly source: SpeakerAttributionInputMaterializerSource;
  }> {
    const graphCheckpoint = this.currentCheckpoints.get('character_graph_merge');
    if (!graphCheckpoint) throw new Error('Merged Character Graph checkpoint is missing');
    const [labelingSource, allChapterParagraphs, graph, snapshot, previousContext] = await Promise.all([
      this.loadLabelingSource(window),
      this.paragraphs(window.chapterId),
      this.loadGraphCheckpoint(graphCheckpoint),
      this.repository.getNativeAnalysisPromotionSnapshot(this.plan.novelId, window.chapterId),
      this.compactPreviousContext(window),
    ]);
    if (snapshot.activeContentRevisionId !== this.source.contentRevisionId) {
      throw new Error('Native compact speaker source revision changed before materialization');
    }
    const chapterWindows = this.plan.labelingWindows.filter((candidate) => candidate.chapterId === window.chapterId);
    const finalWindowForChapter = chapterWindows[chapterWindows.length - 1]?.id === window.id;
    return {
      labelingSource,
      source: {
        bookId: this.plan.novelId,
        contentRevisionId: snapshot.activeContentRevisionId,
        normalizedTextHash: this.source.novel.normalizedTextHash,
        graphRevision: snapshot.graphFingerprint,
        correctionCursor: snapshot.correctionFingerprint,
        chapter: labelingSource.chapter,
        paragraphs: labelingSource.paragraphs,
        allChapterParagraphs,
        characters: graph.characters,
        graphKnowledge: this.graphKnowledge ?? backfillCharacterGraphKnowledgeV2(graph),
        previousEpisodeContext: previousContext,
        userCorrections: labelingSource.userCorrections ?? [],
        providerId: this.provider.providerId,
        modelId: this.provider.modelId,
        providerOptions: this.provider.providerOptions,
        coversFullChapter: labelingSource.paragraphs.length === allChapterParagraphs.length,
        finalWindowForChapter,
      },
    };
  }

  private compactMaterializationKey(workflow: NativeBookWorkflowView, windowId: string): string {
    return `${workflow.id}\u0000${workflow.fence}\u0000${windowId}`;
  }

  private materializeCompactSpeakerWindow(
    workflow: NativeBookWorkflowView,
    window: BookAIWorkflowLabelingWindow,
  ): Promise<NativeCompactSpeakerMaterialization> {
    const key = this.compactMaterializationKey(workflow, window.id);
    let pending = this.compactMaterializationCache.get(key);
    if (!pending) {
      pending = this.compactSpeakerSource(window).then(async ({ source }) => {
        const lockedSpans = await this.lockedSpeakerSpans(window.chapterId, source.allChapterParagraphs);
        const prepared = prepareSpeakerAttributionInputMaterialization(source, lockedSpans);
        await replaceSpeakerAttributionChapterInventory(prepared.chapterBuild.inventory);
        await appendTemporalAddressUseEvents(prepared.chapterBuild.inventory.addressEvents);
        const [addressEvents, temporalRelationEdges, sourceManifest] = await Promise.all([
          listTemporalAddressUseEvents(source.contentRevisionId, { activeOnly: true }),
          listTemporalRelationEdges(source.contentRevisionId, { activeOnly: true }),
          getSpeakerSourceManifest(source.contentRevisionId),
        ]);
        const materialized = materializeSpeakerAttributionInput(prepared, {
          addressEvents,
          temporalRelationEdges,
          sourceManifestFingerprint: sourceManifest?.fingerprint,
        });
        await replaceCharacterTemporalSnapshotsForChapter({
          contentRevisionId: source.contentRevisionId,
          chapterId: source.chapter.id,
          snapshots: materialized.snapshots,
        });
        const request = buildNativeSpeakerBatchMaterializeRequest({
          workflowId: workflow.id,
          jobId: window.id,
          expectedFence: workflow.fence,
          source,
          payload: materialized.payload,
        });
        return { ...materialized, source, batch: request.batch, request };
      });
      this.compactMaterializationCache.set(key, pending);
    }
    return pending;
  }

  async materializeCompactLabeling(input: {
    readonly workflow: NativeBookWorkflowView;
    readonly window: BookAIWorkflowLabelingWindow;
  }): Promise<NativeBookWorkflowMaterializeRequest> {
    return (await this.materializeCompactSpeakerWindow(input.workflow, input.window)).request;
  }

  private loadBundleCheckpoint(
    checkpoint: NativeWorkflowCheckpointResult,
    windowId: string,
  ): Promise<CharacterBundleAnalysisResult> {
    let pending = this.bundleCheckpointCache.get(checkpoint.jobId);
    if (!pending) {
      const window = this.plan.bundleWindows.find((candidate) => candidate.id === windowId);
      if (!window) throw new Error(`Native bundle window not found: ${windowId}`);
      pending = this.loadBundleSource(window.chapterIds).then(async (source) => {
        const result = characterBundleResponseToResult(
          {
            novelId: this.plan.novelId,
            bundleId: window.bundleId,
            chapters: [...source.chapters],
            existingGraph: source.existingGraph,
            userCorrections: source.userCorrections ? [...source.userCorrections] : undefined,
          },
          parseCharacterBundleResponse(checkpoint.output),
        );
        if (result.observationsV2 && typeof this.repository.saveCharacterGraphObservationsV2 === 'function') {
          await this.repository.saveCharacterGraphObservationsV2(result.observationsV2);
          this.graphKnowledge = await this.repository.getCharacterGraphKnowledgeV2(this.plan.novelId);
        }
        return result;
      });
      this.bundleCheckpointCache.set(checkpoint.jobId, pending);
    }
    return pending;
  }

  private loadGraphCheckpoint(checkpoint: NativeWorkflowCheckpointResult): Promise<CharacterGraph> {
    this.graphCheckpointCache ??= this.graphCheckpointInput().then((input) =>
      characterGraphResponseToGraph(input, parseCharacterGraphResponse(checkpoint.output)),
    );
    return this.graphCheckpointCache;
  }

  private async graphCheckpointInput(): Promise<MergeCharacterGraphInput> {
    const bundleResults = await Promise.all(
      this.plan.bundleWindows.map((window) => {
        const checkpoint = this.currentCheckpoints.get(window.id);
        if (!checkpoint) throw new Error(`Bundle checkpoint missing while parsing graph: ${window.id}`);
        return this.loadBundleCheckpoint(checkpoint, window.id);
      }),
    );
    const source = await this.loadGraphMergeSource();
    return {
      novelId: this.plan.novelId,
      existingGraph: source.existingGraph,
      discoveredGraph: {
        novelId: this.plan.novelId,
        characters: bundleResults.flatMap((result) => result.discoveredGraph.characters),
        relations: bundleResults.flatMap((result) => result.discoveredGraph.relations),
      },
      userCorrections: source.userCorrections ? [...source.userCorrections] : undefined,
    };
  }

  private loadLabelingCheckpoint(
    checkpoint: NativeWorkflowCheckpointResult,
    windowId: string,
  ): Promise<ChapterLabelingResult> {
    if (this.labelingContract?.kind === 'speaker_attribution_v3') {
      return this.loadCompactSpeakerCheckpoint(checkpoint, windowId).then((result) => result.aggregation.result);
    }
    let pending = this.labelingCheckpointCache.get(checkpoint.jobId);
    if (!pending) {
      const window = this.plan.labelingWindows.find((candidate) => candidate.id === windowId);
      if (!window) throw new Error(`Native labeling window not found: ${windowId}`);
      pending = this.loadLabelingSource(window).then(async (source) => {
        const windowIndex = this.plan.labelingWindows.findIndex((candidate) => candidate.id === window.id);
        let previousContext: LabelChapterSegmentsInput['previousEpisodeContext'];
        for (let index = windowIndex - 1; index >= 0 && !previousContext; index -= 1) {
          const previousWindow = this.plan.labelingWindows[index];
          const previousCheckpoint = this.currentCheckpoints.get(previousWindow.id);
          if (!previousCheckpoint)
            throw new Error(`Previous native labeling checkpoint is missing: ${previousWindow.id}`);
          const previousResult = await this.loadLabelingCheckpoint(previousCheckpoint, previousWindow.id);
          const previousSource = await this.loadLabelingSource(previousWindow);
          previousContext = previousEpisodeContext(previousResult, previousSource.paragraphs, previousWindow.id);
        }
        return parseNativeLabelingCheckpoint({
          output: checkpoint.output,
          providerOptions: this.provider.providerOptions,
          labelingContract: this.labelingContract,
          labelingInput: {
            novelId: this.plan.novelId,
            chapter: source.chapter,
            paragraphs: [...source.paragraphs],
            windowId: window.id,
            inputRevisionId: `${checkpoint.workflowId}:${window.id}`,
            knownCharacters: source.knownCharacters ? [...source.knownCharacters] : undefined,
            previousEpisodeContext: previousContext,
            userCorrections: source.userCorrections ? [...source.userCorrections] : undefined,
          },
        });
      });
      this.labelingCheckpointCache.set(checkpoint.jobId, pending);
    }
    return pending;
  }

  private loadCompactSpeakerCheckpoint(
    checkpoint: NativeWorkflowCheckpointResult,
    windowId: string,
  ): Promise<NativeCompactSpeakerCheckpoint> {
    let pending = this.compactCheckpointCache.get(checkpoint.jobId);
    if (!pending) {
      const workflow = this.workflow;
      const window = this.plan.labelingWindows.find((candidate) => candidate.id === windowId);
      if (!workflow) throw new Error('Native compact workflow view is unavailable while parsing its checkpoint');
      if (!window) throw new Error(`Native labeling window not found: ${windowId}`);
      pending = Promise.all([
        this.loadLabelingSource(window),
        this.materializeCompactSpeakerWindow(workflow, window),
      ]).then(([source, materialization]) => ({
        source,
        materialization,
        aggregation: aggregateNativeSpeakerBatchCheckpoint({
          jobId: window.id,
          correctionFingerprint: materialization.source.correctionCursor,
          payload: materialization.payload,
          batch: materialization.batch,
          checkpointOutput: checkpoint.output,
        }),
      }));
      this.compactCheckpointCache.set(checkpoint.jobId, pending);
    }
    return pending;
  }

  private currentCheckpoints = new Map<string, NativeWorkflowCheckpointResult>();

  setCheckpoints(checkpoints: readonly NativeWorkflowCheckpointResult[]): void {
    this.currentCheckpoints = new Map(checkpoints.map((checkpoint) => [checkpoint.jobId, checkpoint]));
  }

  async bundleResult(checkpoint: NativeWorkflowCheckpointResult): Promise<CharacterBundleAnalysisResult> {
    return this.loadBundleCheckpoint(checkpoint, checkpoint.jobId);
  }

  async graphResult(checkpoint: NativeWorkflowCheckpointResult): Promise<CharacterGraph> {
    return this.loadGraphCheckpoint(checkpoint);
  }

  async labelingResult(checkpoint: NativeWorkflowCheckpointResult): Promise<{
    readonly source: NativeLabelingSource;
    readonly result: ChapterLabelingResult;
  }> {
    const window = this.plan.labelingWindows.find((candidate) => candidate.id === checkpoint.jobId);
    if (!window) throw new Error(`Native labeling window not found: ${checkpoint.jobId}`);
    const source = await this.loadLabelingSource(window);
    const result = await this.loadLabelingCheckpoint(checkpoint, window.id);
    return { source, result };
  }

  async speakerBatchResult(checkpoint: NativeWorkflowCheckpointResult): Promise<NativeCompactSpeakerCheckpoint> {
    if (this.labelingContract?.kind !== 'speaker_attribution_v3') {
      throw new Error(`Native labeling checkpoint is not compact speaker attribution: ${checkpoint.jobId}`);
    }
    return this.loadCompactSpeakerCheckpoint(checkpoint, checkpoint.jobId);
  }
}
