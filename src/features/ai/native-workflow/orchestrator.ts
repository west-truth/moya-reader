import type {
  AnalyzeCharacterBundleInput,
  ChapterLabelingPreviousContext,
  ChapterLabelingResult,
  CharacterBundleAnalysisResult,
  CharacterBundleChapterInput,
  CharacterGraph,
  LabelChapterSegmentsInput,
  MergeCharacterGraphInput,
} from '../../../providers/ai';
import type {
  BookAIWorkflowBundleWindow,
  BookAIWorkflowLabelingWindow,
  BookAIWorkflowPlan,
} from '../../../providers/book-ai-workflow-plan';
import type { Chapter, Character, Paragraph, UserCorrection } from '../../../domain/types';
import { episodeContextFromResult } from '../../../providers/episode-context';
import type {
  NativeBookWorkflowBridge,
  NativeBookWorkflowFinalizeRequest,
  NativeBookWorkflowMaterializeRequest,
  NativeBookWorkflowView,
  NativeStructuredJsonRequest,
  NativeWorkflowCheckpointResult,
  NativeWorkflowReadinessOutcome,
  NativeWorkflowStage,
} from './contracts';
import { nativeBookWorkflowPlanHash } from './manifest';

type Awaitable<T> = T | Promise<T>;

export interface NativeBundleSource {
  readonly chapters: readonly CharacterBundleChapterInput[];
  readonly existingGraph?: CharacterGraph;
  readonly userCorrections?: readonly UserCorrection[];
}

export interface NativeGraphMergeSource {
  readonly existingGraph: CharacterGraph;
  readonly userCorrections?: readonly UserCorrection[];
}

export interface NativeLabelingSource {
  readonly chapter: Chapter;
  readonly paragraphs: readonly Paragraph[];
  readonly knownCharacters?: readonly Character[];
  readonly userCorrections?: readonly UserCorrection[];
  readonly haloParagraphs?: readonly Paragraph[];
}

export interface NativeWorkflowMaterializationLoaders {
  loadBundleSource(window: BookAIWorkflowBundleWindow): Awaitable<NativeBundleSource>;
  loadGraphMergeSource(plan: BookAIWorkflowPlan): Awaitable<NativeGraphMergeSource>;
  loadLabelingSource(window: BookAIWorkflowLabelingWindow): Awaitable<NativeLabelingSource>;
  loadBundleCheckpoint(
    checkpoint: NativeWorkflowCheckpointResult,
    window: BookAIWorkflowBundleWindow,
  ): Awaitable<CharacterBundleAnalysisResult>;
  loadGraphCheckpoint(checkpoint: NativeWorkflowCheckpointResult): Awaitable<CharacterGraph>;
  loadLabelingCheckpoint(
    checkpoint: NativeWorkflowCheckpointResult,
    window: BookAIWorkflowLabelingWindow,
  ): Awaitable<ChapterLabelingResult>;
}

export interface NativeWorkflowRequestBuilders {
  buildBundleRequest(input: AnalyzeCharacterBundleInput): Awaitable<NativeStructuredJsonRequest>;
  buildGraphMergeRequest(input: MergeCharacterGraphInput): Awaitable<NativeStructuredJsonRequest>;
  buildLabelingRequest(input: LabelChapterSegmentsInput): Awaitable<NativeStructuredJsonRequest>;
}

export interface NativeWorkflowFinalizationDecision {
  readonly outcome: NativeWorkflowReadinessOutcome;
  readonly reviewItems: readonly unknown[];
}

export type NativeWorkflowFinalizationEvaluator = (input: {
  readonly plan: BookAIWorkflowPlan;
  readonly workflow: NativeBookWorkflowView;
  readonly checkpoints: readonly NativeWorkflowCheckpointResult[];
}) => Awaitable<NativeWorkflowFinalizationDecision>;

export interface NativeWorkflowOrchestratorDependencies {
  readonly bridge: NativeBookWorkflowBridge;
  readonly loaders: NativeWorkflowMaterializationLoaders;
  readonly builders: NativeWorkflowRequestBuilders;
  readonly materializeCompactLabeling?: (input: {
    readonly workflow: NativeBookWorkflowView;
    readonly window: BookAIWorkflowLabelingWindow;
  }) => Awaitable<NativeBookWorkflowMaterializeRequest>;
  readonly evaluateFinalization: NativeWorkflowFinalizationEvaluator;
}

export interface OrchestrateNativeWorkflowStepInput {
  readonly plan: BookAIWorkflowPlan;
  readonly contentRevision: string;
  readonly workflow: NativeBookWorkflowView;
  readonly checkpoints: readonly NativeWorkflowCheckpointResult[];
  readonly dependencies: NativeWorkflowOrchestratorDependencies;
  readonly expectedPlanHash?: string;
}

export interface ResumeNativeWorkflowInput {
  readonly workflowId: string;
  readonly plan: BookAIWorkflowPlan;
  readonly contentRevision: string;
  readonly dependencies: NativeWorkflowOrchestratorDependencies;
  readonly expectedPlanHash?: string;
}

export type NativeWorkflowStepResult =
  | {
      readonly kind: 'materialized';
      readonly stage: Exclude<NativeWorkflowStage, 'tts_ready_preparation'>;
      readonly jobId: string;
      readonly request: NativeBookWorkflowMaterializeRequest;
      readonly workflow: NativeBookWorkflowView;
    }
  | {
      readonly kind: 'finalized';
      readonly request: NativeBookWorkflowFinalizeRequest;
      readonly workflow: NativeBookWorkflowView;
    }
  | {
      readonly kind: 'plan_drift';
      readonly expectedPlanHash: string;
      readonly actualPlanHash: string;
    }
  | {
      readonly kind: 'idle';
      readonly status: NativeBookWorkflowView['status'];
    };

const LEGACY_WORKFLOW_REVIEW_ITEM = {
  id: 'legacy_native_workflow_requires_review',
  kind: 'workflow_error',
  stage: 'tts_ready_preparation',
  errorCode: 'legacy_native_workflow_requires_review',
  message:
    'This workflow predates revision-safe local promotion. Start a new analysis before using its labels for TTS.',
  recommendedAction: 'retry_workflow',
} as const;

interface OrderedPlanJob {
  readonly id: string;
  readonly stage: Exclude<NativeWorkflowStage, 'tts_ready_preparation'>;
}

function orderedPlanJobs(plan: BookAIWorkflowPlan): OrderedPlanJob[] {
  return [
    ...plan.bundleWindows.map((window) => ({ id: window.id, stage: 'character_graph_bootstrap' as const })),
    { id: 'character_graph_merge', stage: 'character_graph_merge' as const },
    ...plan.labelingWindows.map((window) => ({ id: window.id, stage: 'chapter_labeling' as const })),
  ];
}

function checkpointsByJobId(
  orderedJobs: readonly OrderedPlanJob[],
  checkpoints: readonly NativeWorkflowCheckpointResult[],
): Map<string, NativeWorkflowCheckpointResult> {
  const knownJobIds = new Set(orderedJobs.map((job) => job.id));
  const byJobId = new Map<string, NativeWorkflowCheckpointResult>();
  for (const checkpoint of checkpoints) {
    if (!knownJobIds.has(checkpoint.jobId)) {
      throw new Error(`Native workflow checkpoint does not belong to the canonical plan: ${checkpoint.jobId}`);
    }
    if (byJobId.has(checkpoint.jobId)) {
      throw new Error(`Native workflow checkpoint is duplicated: ${checkpoint.jobId}`);
    }
    byJobId.set(checkpoint.jobId, checkpoint);
  }
  let foundGap = false;
  for (const job of orderedJobs) {
    if (!byJobId.has(job.id)) foundGap = true;
    else if (foundGap) throw new Error(`Native workflow checkpoints are not a completed prefix: ${job.id}`);
  }
  return byJobId;
}

export function previousEpisodeContext(
  result: ChapterLabelingResult,
  paragraphs: readonly Paragraph[],
  sourceWindowId: string,
  speakerOnly = false,
): ChapterLabelingPreviousContext | undefined {
  const chapterId =
    result.episodeContextSummary?.chapterId ?? result.segments[0]?.chapterId ?? paragraphs[0]?.chapterId;
  if (!chapterId) return undefined;
  return episodeContextFromResult(chapterId, result, {
    paragraphs,
    sourceWindowId,
    speakerOnly,
  });
}

function combinedBundleGraph(novelId: string, bundleResults: readonly CharacterBundleAnalysisResult[]): CharacterGraph {
  return {
    novelId,
    characters: bundleResults.flatMap((result) => result.discoveredGraph.characters),
    relations: bundleResults.flatMap((result) => result.discoveredGraph.relations),
  };
}

async function buildBundleMaterialization(
  input: OrchestrateNativeWorkflowStepInput,
  windowIndex: number,
  checkpoints: ReadonlyMap<string, NativeWorkflowCheckpointResult>,
): Promise<NativeStructuredJsonRequest> {
  const window = input.plan.bundleWindows[windowIndex];
  const source = await input.dependencies.loaders.loadBundleSource(window);
  let previousBundleSummary: string | undefined;
  if (windowIndex > 0) {
    const previousWindow = input.plan.bundleWindows[windowIndex - 1];
    const checkpoint = checkpoints.get(previousWindow.id);
    if (!checkpoint) throw new Error(`Previous bundle checkpoint is missing: ${previousWindow.id}`);
    const result = await input.dependencies.loaders.loadBundleCheckpoint(checkpoint, previousWindow);
    previousBundleSummary = result.bundleSummaryForNext;
  }
  return input.dependencies.builders.buildBundleRequest({
    novelId: input.plan.novelId,
    bundleId: window.bundleId,
    chapters: [...source.chapters],
    existingGraph: source.existingGraph,
    previousBundleSummary,
    userCorrections: source.userCorrections ? [...source.userCorrections] : undefined,
  });
}

async function buildGraphMergeMaterialization(
  input: OrchestrateNativeWorkflowStepInput,
  checkpoints: ReadonlyMap<string, NativeWorkflowCheckpointResult>,
): Promise<NativeStructuredJsonRequest> {
  const bundleResults = await Promise.all(
    input.plan.bundleWindows.map(async (window) => {
      const checkpoint = checkpoints.get(window.id);
      if (!checkpoint) throw new Error(`Bundle checkpoint is missing for graph merge: ${window.id}`);
      return input.dependencies.loaders.loadBundleCheckpoint(checkpoint, window);
    }),
  );
  const source = await input.dependencies.loaders.loadGraphMergeSource(input.plan);
  const summaries = bundleResults
    .map((result) => result.bundleSummaryForNext?.trim())
    .filter((summary): summary is string => Boolean(summary));
  return input.dependencies.builders.buildGraphMergeRequest({
    novelId: input.plan.novelId,
    existingGraph: source.existingGraph,
    discoveredGraph: combinedBundleGraph(input.plan.novelId, bundleResults),
    sourceContext: {
      bundleId: 'character_graph_merge',
      chapterIds: input.plan.bundleWindows.flatMap((window) => window.chapterIds),
      ...(summaries.length > 0 ? { summary: summaries.join('\n') } : {}),
    },
    userCorrections: source.userCorrections ? [...source.userCorrections] : undefined,
  });
}

async function buildLabelingMaterialization(
  input: OrchestrateNativeWorkflowStepInput,
  windowIndex: number,
  checkpoints: ReadonlyMap<string, NativeWorkflowCheckpointResult>,
): Promise<NativeStructuredJsonRequest> {
  const window = input.plan.labelingWindows[windowIndex];
  const graphCheckpoint = checkpoints.get('character_graph_merge');
  if (!graphCheckpoint) throw new Error('Merged Character Graph checkpoint is missing');
  const [source, characterGraph] = await Promise.all([
    input.dependencies.loaders.loadLabelingSource(window),
    input.dependencies.loaders.loadGraphCheckpoint(graphCheckpoint),
  ]);
  let previousContext: ChapterLabelingPreviousContext | undefined;
  for (let index = windowIndex - 1; index >= 0 && !previousContext; index -= 1) {
    const previousWindow = input.plan.labelingWindows[index];
    const checkpoint = checkpoints.get(previousWindow.id);
    if (!checkpoint) throw new Error(`Previous labeling checkpoint is missing: ${previousWindow.id}`);
    const result = await input.dependencies.loaders.loadLabelingCheckpoint(checkpoint, previousWindow);
    const previousSource = await input.dependencies.loaders.loadLabelingSource(previousWindow);
    previousContext = previousEpisodeContext(result, previousSource.paragraphs, previousWindow.id);
  }
  return input.dependencies.builders.buildLabelingRequest({
    novelId: input.plan.novelId,
    chapter: source.chapter,
    paragraphs: [...source.paragraphs],
    windowId: window.id,
    inputRevisionId: `${input.workflow.id}:${window.id}`,
    knownCharacters: source.knownCharacters ? [...source.knownCharacters] : undefined,
    characterGraph,
    previousEpisodeContext: previousContext,
    userCorrections: source.userCorrections ? [...source.userCorrections] : undefined,
    contextHaloParagraphs: source.haloParagraphs ? [...source.haloParagraphs] : undefined,
  });
}

async function requestForNextJob(
  input: OrchestrateNativeWorkflowStepInput,
  nextJob: OrderedPlanJob,
  checkpoints: ReadonlyMap<string, NativeWorkflowCheckpointResult>,
): Promise<NativeStructuredJsonRequest> {
  if (nextJob.stage === 'character_graph_bootstrap') {
    const index = input.plan.bundleWindows.findIndex((window) => window.id === nextJob.id);
    return buildBundleMaterialization(input, index, checkpoints);
  }
  if (nextJob.stage === 'character_graph_merge') {
    return buildGraphMergeMaterialization(input, checkpoints);
  }
  const index = input.plan.labelingWindows.findIndex((window) => window.id === nextJob.id);
  return buildLabelingMaterialization(input, index, checkpoints);
}

async function materializeNextJob(
  input: OrchestrateNativeWorkflowStepInput,
  nextJob: OrderedPlanJob,
  checkpoints: ReadonlyMap<string, NativeWorkflowCheckpointResult>,
): Promise<NativeBookWorkflowMaterializeRequest> {
  if (nextJob.stage === 'chapter_labeling' && input.workflow.schemaVersion === 3) {
    const window = input.plan.labelingWindows.find((candidate) => candidate.id === nextJob.id);
    if (!window || !input.dependencies.materializeCompactLabeling) {
      throw new Error(`Native compact labeling materializer is unavailable: ${nextJob.id}`);
    }
    const request = await input.dependencies.materializeCompactLabeling({ workflow: input.workflow, window });
    if (
      request.workflowId !== input.workflow.id ||
      request.jobId !== nextJob.id ||
      request.expectedFence !== input.workflow.fence ||
      !('batch' in request)
    ) {
      throw new Error(`Native compact labeling materializer returned a mismatched request: ${nextJob.id}`);
    }
    return request;
  }
  return {
    workflowId: input.workflow.id,
    jobId: nextJob.id,
    expectedFence: input.workflow.fence,
    request: await requestForNextJob(input, nextJob, checkpoints),
  };
}

export async function rebuildNativeWorkflowJobRequest(input: {
  readonly plan: BookAIWorkflowPlan;
  readonly contentRevision: string;
  readonly workflow: NativeBookWorkflowView;
  readonly checkpoints: readonly NativeWorkflowCheckpointResult[];
  readonly dependencies: NativeWorkflowOrchestratorDependencies;
  readonly jobId: string;
  readonly expectedPlanHash?: string;
}): Promise<NativeBookWorkflowMaterializeRequest> {
  const expectedPlanHash = input.expectedPlanHash ?? nativeBookWorkflowPlanHash(input.plan, input.contentRevision);
  if (
    input.workflow.planHash !== expectedPlanHash ||
    input.workflow.novelId !== input.plan.novelId ||
    input.workflow.contentRevision !== input.contentRevision
  ) {
    throw new Error('Native workflow plan drifted before request verification');
  }
  const orderedJobs = orderedPlanJobs(input.plan);
  const targetIndex = orderedJobs.findIndex((job) => job.id === input.jobId);
  if (targetIndex < 0) throw new Error(`Native workflow job does not belong to the canonical plan: ${input.jobId}`);
  const prefixIds = new Set(orderedJobs.slice(0, targetIndex).map((job) => job.id));
  const prefix = input.checkpoints.filter((checkpoint) => prefixIds.has(checkpoint.jobId));
  if (prefix.length !== targetIndex) {
    throw new Error(`Native workflow request prefix is incomplete: ${input.jobId}`);
  }
  const checkpoints = checkpointsByJobId(orderedJobs, prefix);
  return materializeNextJob(
    {
      plan: input.plan,
      contentRevision: input.contentRevision,
      workflow: input.workflow,
      checkpoints: prefix,
      dependencies: input.dependencies,
    },
    orderedJobs[targetIndex],
    checkpoints,
  );
}

export async function orchestrateNextNativeWorkflowStep(
  input: OrchestrateNativeWorkflowStepInput,
): Promise<NativeWorkflowStepResult> {
  if (input.workflow.schemaVersion === 1) {
    if (input.workflow.status === 'waiting_for_input' && input.workflow.currentStage === 'tts_ready_preparation') {
      const request: NativeBookWorkflowFinalizeRequest = {
        workflowId: input.workflow.id,
        expectedFence: input.workflow.fence,
        outcome: 'needs_review',
        reviewItems: [LEGACY_WORKFLOW_REVIEW_ITEM],
      };
      const workflow = await input.dependencies.bridge.finalize(request);
      return { kind: 'finalized', request, workflow };
    }
    return { kind: 'idle', status: input.workflow.status };
  }
  const expectedPlanHash = input.expectedPlanHash ?? nativeBookWorkflowPlanHash(input.plan, input.contentRevision);
  if (
    input.workflow.planHash !== expectedPlanHash ||
    input.workflow.novelId !== input.plan.novelId ||
    input.workflow.contentRevision !== input.contentRevision
  ) {
    return { kind: 'plan_drift', expectedPlanHash, actualPlanHash: input.workflow.planHash };
  }
  if (input.workflow.status !== 'waiting_for_input') {
    return { kind: 'idle', status: input.workflow.status };
  }

  const orderedJobs = orderedPlanJobs(input.plan);
  const checkpointMap = checkpointsByJobId(orderedJobs, input.checkpoints);
  const nextJob = orderedJobs.find((job) => !checkpointMap.has(job.id));
  if (!nextJob) {
    const decision = await input.dependencies.evaluateFinalization({
      plan: input.plan,
      workflow: input.workflow,
      checkpoints: input.checkpoints,
    });
    if (decision.outcome === 'ready_for_tts' && decision.reviewItems.length > 0) {
      throw new Error('Ready native workflows must not contain review items');
    }
    if (decision.outcome === 'needs_review' && decision.reviewItems.length === 0) {
      throw new Error('Native workflows needing review must contain review items');
    }
    const request: NativeBookWorkflowFinalizeRequest = {
      workflowId: input.workflow.id,
      expectedFence: input.workflow.fence,
      outcome: decision.outcome,
      reviewItems: [...decision.reviewItems],
    };
    const workflow = await input.dependencies.bridge.finalize(request);
    return { kind: 'finalized', request, workflow };
  }

  const jobView = input.workflow.jobs.find((job) => job.id === nextJob.id);
  if (!jobView || jobView.stage !== nextJob.stage) {
    throw new Error(`Native workflow view is missing the next canonical job: ${nextJob.id}`);
  }
  if (jobView.status !== 'waiting_for_input' || jobView.requestHash !== undefined) {
    return { kind: 'idle', status: input.workflow.status };
  }
  const request = await materializeNextJob(input, nextJob, checkpointMap);
  const workflow = await input.dependencies.bridge.materialize(request);
  return { kind: 'materialized', stage: nextJob.stage, jobId: nextJob.id, request, workflow };
}

export async function resumeNativeWorkflow(input: ResumeNativeWorkflowInput): Promise<NativeWorkflowStepResult> {
  const workflow = await input.dependencies.bridge.resume(input.workflowId);
  const checkpointViews = [...workflow.checkpoints].sort((a, b) => a.sequence - b.sequence);
  const checkpoints = await Promise.all(
    checkpointViews.map((checkpoint) =>
      input.dependencies.bridge.checkpoint({ workflowId: workflow.id, jobId: checkpoint.jobId }),
    ),
  );
  return orchestrateNextNativeWorkflowStep({
    plan: input.plan,
    contentRevision: input.contentRevision,
    workflow,
    checkpoints,
    dependencies: input.dependencies,
    expectedPlanHash: input.expectedPlanHash,
  });
}
