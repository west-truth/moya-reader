import type {
  BookAnalysisWorkflow,
  BookAnalysisWorkflowGateway,
  BookAnalysisWorkflowJob,
  BookAnalysisWorkflowReadiness,
  StartBookAnalysisWorkflowInput,
} from '../book-analysis-workflow-gateway';
import { BookAnalysisWorkflowNotFoundError } from '../book-analysis-workflow-gateway';
import type { BookAIWorkflowReviewItem } from '../../../providers/book-ai-workflow-review';
import type { ProviderJobStatus, ProviderJobType } from '../../../providers/provider-jobs';
import type { JsonValue } from '../../../sync/types';
import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type {
  NativeAnalysisStagedOutput,
  NativeAnalysisWorkflowDescriptor,
  NativeLabelingContract,
} from '../../../storage/native-analysis-workflow';
import { nativeLabelingContractFingerprint } from '../../../storage/native-analysis-workflow';
import type { ChapterLabelAnalysisReviewArtifact } from '../../../providers/analysis-review';
import type { AnalysisReviewEditIntentMap } from '../../../providers/analysis-review-correction';
import { buildNativeBookWorkflowSubmitRequest, buildNativeCompactExecutionManifest } from './manifest';
import type {
  NativeBookWorkflowBridge,
  NativeBookWorkflowJobView,
  NativeBookWorkflowView,
  NativeWorkflowCheckpointResult,
  NativeWorkflowJobStatus,
  NativeWorkflowStage,
} from './contracts';
import {
  NativeWorkflowDependencyFactory,
  planPinnedNativeBookWorkflow,
  type NativeWorkflowReaderRepository,
} from './native-workflow-dependencies';
import {
  nativeAnalysisFenceInput,
  NativeCheckpointReviewError,
  promoteCompletedNativeCheckpoints,
} from './native-promotion-coordinator';
import { evaluateNativeTTSReadiness, type NativeTTSReadinessResult } from './native-tts-readiness';
import { orchestrateNextNativeWorkflowStep } from './orchestrator';
import { prepareNativeAnalysisReviewPromotionSaga, recoverNativeLabelMutationSaga } from './native-label-mutation-saga';
import { buildNativeAnalysisReviewArtifact } from './native-analysis-review';
import { assertNativeLabelingContractExecutable, resolveNativeLabelingContract } from './labeling-contract';

const MAX_TERMINAL_RESUBMITS = 3;
let fallbackRetryNonce = 0;

function forcedWorkflowIdempotencyKey(scopedIdempotencyKey: string): string {
  fallbackRetryNonce += 1;
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${fallbackRetryNonce}`;
  return `${scopedIdempotencyKey}:retry:${nonce}`;
}

function isoTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function stageName(stage: NativeWorkflowStage | null, status: string): string {
  if (status === 'needs_review') return 'needs_review';
  if (status === 'cancelled') return 'cancelled';
  if (stage === 'character_graph_bootstrap') return 'building_graph';
  if (stage === 'character_graph_merge') return 'merging_graph';
  if (stage === 'chapter_labeling') return 'labeling_chapters';
  if (stage === 'tts_ready_preparation') return 'tts_ready_preparation';
  return status;
}

function providerJobType(job: NativeBookWorkflowJobView): ProviderJobType {
  if (job.jobType) return job.jobType;
  if (job.stage === 'character_graph_bootstrap') return 'character_bundle_analysis';
  if (job.stage === 'character_graph_merge') return 'character_graph_merge';
  return 'chapter_segment_labeling';
}

function providerJobStatus(status: NativeWorkflowJobStatus): ProviderJobStatus | undefined {
  if (status === 'waiting_for_input') return undefined;
  return status;
}

function reviewItem(value: unknown): BookAIWorkflowReviewItem | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Partial<BookAIWorkflowReviewItem>;
  if (
    typeof item.id !== 'string' ||
    typeof item.kind !== 'string' ||
    typeof item.severity !== 'string' ||
    typeof item.title !== 'string' ||
    typeof item.detail !== 'string' ||
    typeof item.recommendedAction !== 'string' ||
    typeof item.actionLabel !== 'string'
  ) {
    return undefined;
  }
  return item as BookAIWorkflowReviewItem;
}

function fallbackReviewItem(errorCode: string | null): BookAIWorkflowReviewItem {
  return {
    id: `native_workflow:${errorCode || 'needs_review'}`,
    kind: 'workflow_error',
    severity: 'warning',
    title: '검토가 필요한 로컬 workflow',
    detail: errorCode ? `로컬 분석이 ${errorCode} 상태로 중단되었습니다.` : '로컬 분석 결과를 검토해야 합니다.',
    recommendedAction: 'retry_workflow',
    actionLabel: '원인 확인 후 다시 분석',
    errorCode: errorCode || undefined,
  };
}

function readiness(view: NativeBookWorkflowView): BookAnalysisWorkflowReadiness {
  if (view.readinessOutcome === 'ready_for_tts') return { outcome: 'ready_for_tts', reviewItems: [] };
  if (view.readinessOutcome === 'needs_review' || view.status === 'needs_review') {
    const reviewItems = view.reviewItems
      .map(reviewItem)
      .filter((item): item is BookAIWorkflowReviewItem => Boolean(item));
    return {
      outcome: 'needs_review',
      reviewItems: reviewItems.length > 0 ? reviewItems : [fallbackReviewItem(view.errorCode)],
    };
  }
  if (view.status === 'succeeded') {
    return { outcome: 'needs_review', reviewItems: [fallbackReviewItem('missing_readiness_evidence')] };
  }
  return { outcome: 'pending', reviewItems: [] };
}

function normalizedJobs(
  view: NativeBookWorkflowView,
  descriptor: NativeAnalysisWorkflowDescriptor,
): BookAnalysisWorkflowJob[] {
  const createdAt = isoTime(view.createdAtMs);
  const updatedAt = isoTime(view.updatedAtMs);
  return view.jobs.map((job) => {
    const status = providerJobStatus(job.status);
    return {
      id: `${view.id}:${job.id}`,
      workflowId: view.id,
      providerJobId: job.requestHash ? job.id : undefined,
      stage: stageName(job.stage, job.status),
      planItemId: job.id,
      sequence: job.sequence,
      createdAt,
      job: status
        ? {
            id: job.id,
            novelId: descriptor.novelId,
            chapterId: descriptor.plan.labelingWindows.find((window) => window.id === job.id)?.chapterId,
            type: providerJobType(job),
            providerId: job.providerId ?? descriptor.provider.providerId,
            modelId: job.modelId ?? descriptor.provider.modelId,
            inputHash: job.requestHash ?? descriptor.planHash,
            status,
            stage: stageName(job.stage, job.status),
            createdAt,
            updatedAt,
            errorCode: job.errorCode ?? undefined,
            errorMessage: job.errorCode ? `Native provider job failed: ${job.errorCode}` : undefined,
          }
        : undefined,
    };
  });
}

function readinessProgress(result: NativeTTSReadinessResult | undefined): JsonValue | undefined {
  if (!result) return undefined;
  return {
    ttsReadiness: {
      ok: result.outcome === 'ready_for_tts',
      metrics: { ...result.metrics },
      missingPlannedParagraphIds: [...result.missingPlannedParagraphIds],
      missingCharacterVoiceSpeakerIds: [...result.missingCharacterVoiceSpeakerIds],
    },
  } as JsonValue;
}

function normalizedWorkflow(
  view: NativeBookWorkflowView,
  descriptor: NativeAnalysisWorkflowDescriptor,
  finalReadiness?: NativeTTSReadinessResult,
): BookAnalysisWorkflow {
  const workflowReadiness = readiness(view);
  const status = workflowReadiness.outcome === 'needs_review' ? 'needs_review' : view.status;
  return {
    id: view.id,
    workflowDefinitionId: descriptor.workflowDefinitionId,
    workflowVersion: descriptor.workflowVersion,
    novelId: descriptor.novelId,
    workflowType: 'book_ai_tts',
    runtime: 'native',
    providerId: descriptor.provider.providerId,
    modelId: descriptor.provider.modelId,
    planHash: descriptor.planHash,
    plan: descriptor.plan,
    status,
    stage: workflowReadiness.outcome === 'ready_for_tts' ? 'ready_for_tts' : stageName(view.currentStage, status),
    readiness: workflowReadiness,
    progress: readinessProgress(finalReadiness),
    jobs: normalizedJobs(view, descriptor),
    createdAt: isoTime(view.createdAtMs),
    updatedAt: isoTime(view.updatedAtMs),
    startedAt: view.jobs.some((job) => job.attempt > 0) ? isoTime(view.createdAtMs) : undefined,
    finishedAt: ['succeeded', 'needs_review', 'cancelled'].includes(status) ? isoTime(view.updatedAtMs) : undefined,
    errorCode: view.errorCode ?? undefined,
    errorMessage: view.errorCode ? `Native workflow failed: ${view.errorCode}` : undefined,
  };
}

function requireContentRevision(contentRevisionId: string | undefined): string {
  if (!contentRevisionId) {
    throw new Error('이 책은 revision-pinned 로컬 분석을 지원하는 형식으로 다시 가져와야 합니다.');
  }
  return contentRevisionId;
}

export class NativeBookAnalysisWorkflowGateway implements BookAnalysisWorkflowGateway {
  readonly runtime = 'native' as const;
  readonly supportsTTSCacheReadiness = false;

  constructor(
    private readonly bridge: NativeBookWorkflowBridge,
    private readonly repository: NativeWorkflowReaderRepository,
  ) {}

  async getPlan(bookId: string, options = {}, signal?: AbortSignal): Promise<NativeAnalysisWorkflowDescriptor['plan']> {
    const source = await this.repository.openContentRevision(bookId);
    requireContentRevision(source.contentRevisionId);
    return planPinnedNativeBookWorkflow({ source, options, signal });
  }

  async start(input: StartBookAnalysisWorkflowInput, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    const providerId = input.providerId?.trim();
    const modelId = input.modelId?.trim();
    if (!providerId || !modelId) throw new Error('기기 로컬 작품 분석 provider와 model을 선택하세요.');
    const source = await this.repository.openContentRevision(input.bookId);
    const contentRevisionId = requireContentRevision(source.contentRevisionId);
    const provider = { providerId, modelId, providerOptions: input.providerOptions ?? {} };
    const labelingContract = resolveNativeLabelingContract(provider.providerOptions);
    assertNativeLabelingContractExecutable(labelingContract);
    const plan = await planPinnedNativeBookWorkflow({ source, options: input.planOptions, provider, signal });
    const predecessorView = await this.bridge.getActive({ novelId: input.bookId, contentRevision: contentRevisionId });
    const predecessorDescriptor = predecessorView
      ? await this.repository.getNativeAnalysisWorkflowDescriptor(predecessorView.id)
      : undefined;
    const predecessorId =
      predecessorDescriptor?.workflowDefinitionId === input.workflowDefinitionId &&
      predecessorDescriptor.workflowVersion === input.workflowVersion
        ? predecessorView?.id
        : undefined;
    const replacement = await this.submit({
      source,
      plan,
      contentRevisionId,
      workflowDefinitionId: input.workflowDefinitionId,
      workflowVersion: input.workflowVersion,
      provider,
      labelingContract,
      force: input.force,
      signal,
    });
    return this.retirePredecessor(replacement, predecessorId, signal);
  }

  async get(workflowId: string, _signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    const descriptor = await this.requireDescriptor(workflowId);
    try {
      return this.advance(await this.bridge.get(workflowId), descriptor);
    } catch (error) {
      if (String(error).includes('native workflow was not found')) {
        throw new BookAnalysisWorkflowNotFoundError(workflowId);
      }
      throw error;
    }
  }

  async getActive(bookId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow | undefined> {
    const source = await this.repository.openContentRevision(bookId);
    const contentRevision = requireContentRevision(source.contentRevisionId);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const view = await this.bridge.getActive({ novelId: bookId, contentRevision });
    if (!view) return undefined;
    const descriptor = await this.repository.getNativeAnalysisWorkflowDescriptor(view.id);
    return descriptor ? normalizedWorkflow(view, descriptor) : undefined;
  }

  async retry(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    signal?.throwIfAborted();
    const descriptor = await this.requireDescriptor(workflowId);
    const view = await this.bridge.get(workflowId);
    if (view.status === 'failed') return this.advance(await this.bridge.resume(workflowId), descriptor);
    if (view.status !== 'needs_review') return normalizedWorkflow(view, descriptor);
    const source = await this.repository.openContentRevision(descriptor.novelId);
    if (requireContentRevision(source.contentRevisionId) !== descriptor.contentRevisionId) {
      throw new Error('본문 revision이 변경되어 기존 로컬 분석을 재시도할 수 없습니다. 새 분석을 시작하세요.');
    }
    const replacement = await this.submit({
      source,
      plan: descriptor.plan,
      contentRevisionId: descriptor.contentRevisionId,
      workflowDefinitionId: descriptor.workflowDefinitionId,
      workflowVersion: descriptor.workflowVersion,
      provider: descriptor.provider,
      labelingContract:
        descriptor.labelingContract ?? resolveNativeLabelingContract(descriptor.provider.providerOptions),
      force: true,
      signal,
    });
    return this.retirePredecessor(replacement, workflowId, signal);
  }

  async cancel(workflowId: string, _signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    const descriptor = await this.requireDescriptor(workflowId);
    return normalizedWorkflow(await this.bridge.cancel(workflowId), descriptor);
  }

  async listReviews(workflowId: string, signal?: AbortSignal): Promise<readonly ChapterLabelAnalysisReviewArtifact[]> {
    signal?.throwIfAborted();
    const descriptor = await this.requireDescriptor(workflowId);
    const view = await this.bridge.get(workflowId);
    return this.loadReviewArtifacts(descriptor, view, undefined, signal);
  }

  async saveReviewDraft(
    reviewId: string,
    expectedReviewRevision: number,
    candidate: ChapterLabelAnalysisReviewArtifact['candidate'],
    signal?: AbortSignal,
    editIntents: AnalysisReviewEditIntentMap = {},
  ): Promise<ChapterLabelAnalysisReviewArtifact> {
    signal?.throwIfAborted();
    const artifact = await this.requireReviewArtifact(reviewId);
    await this.repository.saveNativeAnalysisReviewDraft({
      artifactId: reviewId,
      expectedReviewRevision,
      candidate,
      editIntents,
    });
    return this.reloadReviewArtifact(artifact.workflowId, reviewId, signal);
  }

  async rejectReview(
    reviewId: string,
    expectedReviewRevision: number,
    reason?: string,
    signal?: AbortSignal,
  ): Promise<ChapterLabelAnalysisReviewArtifact> {
    signal?.throwIfAborted();
    const artifact = await this.requireReviewArtifact(reviewId);
    await this.repository.rejectNativeAnalysisReview({ artifactId: reviewId, expectedReviewRevision, reason });
    return this.reloadReviewArtifact(artifact.workflowId, reviewId, signal);
  }

  async approveReview(
    reviewId: string,
    expectedReviewRevision: number,
    signal?: AbortSignal,
  ): Promise<ChapterLabelAnalysisReviewArtifact> {
    signal?.throwIfAborted();
    const artifact = await this.requireReviewArtifact(reviewId);
    const descriptor = await this.requireDescriptor(artifact.workflowId);
    const workflow = await this.bridge.get(artifact.workflowId);
    if (workflow.status !== 'needs_review') throw new Error('Native workflow is not waiting for review approval');
    const source = await this.repository.openContentRevision(descriptor.novelId);
    const reviews = await this.loadReviewArtifacts(descriptor, workflow, source, signal);
    const review = reviews.find((item) => item.id === reviewId);
    if (!review || review.reviewRevision !== expectedReviewRevision) {
      throw new Error('Native analysis review changed before approval');
    }
    if (review.validationSummary.errorCount > 0 || review.qualitySummary.errorCount > 0) {
      throw new Error('검증 오류를 모두 수정한 뒤 승인하세요.');
    }
    const approvedAt = review.updatedAt;
    const command = {
      kind: 'native_review_promotion_v1' as const,
      operationId: persistentId128('native_review_promotion', [
        review.id,
        String(review.reviewRevision),
        review.candidateHash,
      ]),
      artifactId: review.id,
      expectedReviewRevision: review.reviewRevision,
      candidateHash: review.candidateHash,
      editIntentsHash: structuredIntegrityHash(review.editIntents),
      approvedAt,
    };
    const promoted = await prepareNativeAnalysisReviewPromotionSaga({
      workflow,
      command,
      bridge: this.bridge,
      repository: this.repository,
    });
    await this.advance(promoted.workflow, descriptor, source);
    return this.reloadReviewArtifact(artifact.workflowId, reviewId, signal);
  }

  private async submit(input: {
    readonly source: Awaited<ReturnType<NativeWorkflowReaderRepository['openContentRevision']>>;
    readonly plan: NativeAnalysisWorkflowDescriptor['plan'];
    readonly contentRevisionId: string;
    readonly workflowDefinitionId: NativeAnalysisWorkflowDescriptor['workflowDefinitionId'];
    readonly workflowVersion: string;
    readonly provider: NativeAnalysisWorkflowDescriptor['provider'];
    readonly labelingContract: NativeLabelingContract;
    readonly force?: boolean;
    readonly signal?: AbortSignal;
    readonly terminalResubmitCount?: number;
  }): Promise<BookAnalysisWorkflow> {
    input.signal?.throwIfAborted();
    assertNativeLabelingContractExecutable(input.labelingContract);
    const compactExecutionManifest =
      input.labelingContract.kind === 'speaker_attribution_v3'
        ? buildNativeCompactExecutionManifest(input.plan, nativeLabelingContractFingerprint(input.labelingContract))
        : undefined;
    const baseSubmitRequest = buildNativeBookWorkflowSubmitRequest({
      plan: input.plan,
      contentRevision: input.contentRevisionId,
      workflowDefinitionId: input.workflowDefinitionId,
      workflowVersion: input.workflowVersion,
      compactExecutionManifest,
    });
    const submitRequest = input.force
      ? { ...baseSubmitRequest, idempotencyKey: forcedWorkflowIdempotencyKey(baseSubmitRequest.idempotencyKey) }
      : baseSubmitRequest;
    const view = await this.bridge.submit(submitRequest);
    if (['succeeded', 'failed', 'cancelled', 'needs_review'].includes(view.status)) {
      const terminalResubmitCount = input.terminalResubmitCount ?? 0;
      if (terminalResubmitCount >= MAX_TERMINAL_RESUBMITS) {
        throw new Error('Native workflow could not allocate a fresh execution identity.');
      }
      return this.submit({ ...input, force: true, terminalResubmitCount: terminalResubmitCount + 1 });
    }
    if (input.signal?.aborted) {
      await this.bridge.cancel(view.id).catch(() => undefined);
      input.signal.throwIfAborted();
    }
    let descriptor: NativeAnalysisWorkflowDescriptor;
    try {
      descriptor = await this.repository.saveNativeAnalysisWorkflowDescriptor({
        workflowId: view.id,
        workflowDefinitionId: input.workflowDefinitionId,
        workflowVersion: input.workflowVersion,
        novelId: input.plan.novelId,
        contentRevisionId: input.contentRevisionId,
        planHash: submitRequest.planHash,
        plan: input.plan,
        provider: input.provider,
        labelingContract: input.labelingContract,
      });
      await this.repository.saveNativeAnalysisWorkflowFence(nativeAnalysisFenceInput(descriptor, view));
      input.signal?.throwIfAborted();
    } catch (error) {
      await this.bridge.cancel(view.id).catch(() => undefined);
      throw error;
    }
    return this.advance(view, descriptor, input.source);
  }

  private async requireDescriptor(workflowId: string): Promise<NativeAnalysisWorkflowDescriptor> {
    const descriptor = await this.repository.getNativeAnalysisWorkflowDescriptor(workflowId);
    if (!descriptor) throw new BookAnalysisWorkflowNotFoundError(workflowId);
    return descriptor;
  }

  private async requireReviewArtifact(reviewId: string): Promise<NativeAnalysisStagedOutput> {
    const artifact = await this.repository.getNativeAnalysisStagedOutput(reviewId);
    if (!artifact || artifact.payload.kind !== 'label_window' || !artifact.payload.result) {
      throw new Error(`Native analysis review not found: ${reviewId}`);
    }
    return artifact;
  }

  private async reloadReviewArtifact(
    workflowId: string,
    reviewId: string,
    signal?: AbortSignal,
  ): Promise<ChapterLabelAnalysisReviewArtifact> {
    const reviews = await this.listReviews(workflowId, signal);
    const review = reviews.find((item) => item.id === reviewId);
    if (!review) throw new Error(`Native analysis review not found: ${reviewId}`);
    return review;
  }

  private async loadReviewArtifacts(
    descriptor: NativeAnalysisWorkflowDescriptor,
    workflow: NativeBookWorkflowView,
    pinnedSource?: Awaited<ReturnType<NativeWorkflowReaderRepository['openContentRevision']>>,
    signal?: AbortSignal,
  ): Promise<ChapterLabelAnalysisReviewArtifact[]> {
    const source = pinnedSource ?? (await this.repository.openContentRevision(descriptor.novelId));
    if (requireContentRevision(source.contentRevisionId) !== descriptor.contentRevisionId) return [];
    const [artifacts, chapters, characters, relations] = await Promise.all([
      this.repository.listNativeAnalysisStagedOutputs(workflow.id),
      source.listChapters(),
      this.repository.listCharacters(descriptor.novelId),
      this.repository.listCharacterRelations(descriptor.novelId),
    ]);
    const graph = { novelId: descriptor.novelId, characters, relations };
    const reviews: ChapterLabelAnalysisReviewArtifact[] = [];
    for (const artifact of artifacts) {
      signal?.throwIfAborted();
      if (artifact.payload.kind !== 'label_window' || !artifact.payload.result || !artifact.chapterId) continue;
      const enteredReview =
        Boolean(artifact.reviewStatus) || (workflow.status === 'needs_review' && artifact.status !== 'promoted');
      if (!enteredReview) continue;
      const chapter = chapters.find((item) => item.id === artifact.chapterId);
      if (!chapter) continue;
      const chapterParagraphs = await source.listParagraphs(chapter.id);
      reviews.push(
        buildNativeAnalysisReviewArtifact({ artifact, descriptor, workflow, chapter, chapterParagraphs, graph }),
      );
    }
    return reviews.sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  }

  private async retirePredecessor(
    replacement: BookAnalysisWorkflow,
    predecessorId: string | undefined,
    signal?: AbortSignal,
  ): Promise<BookAnalysisWorkflow> {
    if (!predecessorId || predecessorId === replacement.id) return replacement;
    try {
      signal?.throwIfAborted();
      await this.bridge.cancel(predecessorId);
      return replacement;
    } catch (error) {
      await this.bridge.cancel(replacement.id).catch(() => undefined);
      throw error;
    }
  }

  private async advance(
    initialView: NativeBookWorkflowView,
    descriptor: NativeAnalysisWorkflowDescriptor,
    pinnedSource?: Awaited<ReturnType<NativeWorkflowReaderRepository['openContentRevision']>>,
  ): Promise<BookAnalysisWorkflow> {
    assertNativeLabelingContractExecutable(descriptor.labelingContract);
    initialView = await recoverNativeLabelMutationSaga({
      workflow: initialView,
      bridge: this.bridge,
      repository: this.repository,
    });
    const source = pinnedSource ?? (await this.repository.openContentRevision(descriptor.novelId));
    if (requireContentRevision(source.contentRevisionId) !== descriptor.contentRevisionId) {
      const reviewed = await this.bridge.requireReview({
        workflowId: initialView.id,
        expectedFence: initialView.fence,
        errorCode: 'native_content_revision_changed',
        reviewItems: [fallbackReviewItem('native_content_revision_changed')],
      });
      return normalizedWorkflow(reviewed, descriptor);
    }
    const dependencyFactory = new NativeWorkflowDependencyFactory(
      source,
      this.repository,
      descriptor.plan,
      descriptor.provider,
      descriptor.labelingContract,
    );
    await dependencyFactory.initialize();
    dependencyFactory.setWorkflow(initialView);
    const checkpoints = await this.loadCheckpoints(initialView);
    let finalReadiness: NativeTTSReadinessResult | undefined;
    try {
      await promoteCompletedNativeCheckpoints({
        workflow: initialView,
        descriptor,
        checkpoints,
        dependencies: dependencyFactory,
        repository: this.repository,
        bridge: this.bridge,
      });
      const step = await orchestrateNextNativeWorkflowStep({
        plan: descriptor.plan,
        contentRevision: descriptor.contentRevisionId,
        workflow: initialView,
        checkpoints,
        dependencies: {
          bridge: this.bridge,
          loaders: dependencyFactory.loaders,
          builders: dependencyFactory.builders,
          materializeCompactLabeling: (materializeInput) =>
            dependencyFactory.materializeCompactLabeling(materializeInput),
          evaluateFinalization: async () => {
            finalReadiness = await evaluateNativeTTSReadiness({
              novelId: descriptor.novelId,
              plan: descriptor.plan,
              repository: this.repository,
            });
            return finalReadiness;
          },
        },
        expectedPlanHash: descriptor.planHash,
      });
      if (step.kind === 'plan_drift') {
        const reviewed = await this.bridge.requireReview({
          workflowId: initialView.id,
          expectedFence: initialView.fence,
          errorCode: 'native_plan_drift',
          reviewItems: [fallbackReviewItem('native_plan_drift')],
        });
        return normalizedWorkflow(reviewed, descriptor);
      }
      return normalizedWorkflow(step.kind === 'idle' ? initialView : step.workflow, descriptor, finalReadiness);
    } catch (error) {
      if (!(error instanceof NativeCheckpointReviewError)) throw error;
      const reviewed = await this.bridge.requireReview({
        workflowId: initialView.id,
        expectedFence: initialView.fence,
        errorCode: 'native_checkpoint_requires_review',
        reviewItems: error.reviewItems,
      });
      return normalizedWorkflow(reviewed, descriptor);
    }
  }

  private loadCheckpoints(view: NativeBookWorkflowView): Promise<NativeWorkflowCheckpointResult[]> {
    return Promise.all(
      [...view.checkpoints]
        .sort((left, right) => left.sequence - right.sequence)
        .map((checkpoint) => this.bridge.checkpoint({ workflowId: view.id, jobId: checkpoint.jobId })),
    );
  }
}
