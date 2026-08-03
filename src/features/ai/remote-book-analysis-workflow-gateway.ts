import type { BookAIWorkflowPlanOptions } from '../../providers/book-ai-workflow-plan';
import { buildBookAIWorkflowReviewItems, type BookAIWorkflowReviewItem } from '../../providers/book-ai-workflow-review';
import type { RemoteApiClient, RemoteBookAIWorkflow } from '../../services/remote/remote-api-client';
import type {
  BookAnalysisWorkflow,
  BookAnalysisWorkflowGateway,
  StartBookAnalysisWorkflowInput,
} from './book-analysis-workflow-gateway';
import type { ChapterLabelAnalysisReviewArtifact } from '../../providers/analysis-review';
import type { AnalysisReviewEditIntentMap } from '../../providers/analysis-review-correction';

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function missingReadinessEvidence(): BookAIWorkflowReviewItem {
  return {
    id: 'workflow:missing_readiness_evidence',
    kind: 'workflow_error',
    severity: 'warning',
    title: '준비도 증거가 없는 완료 workflow',
    detail: '서버가 완료 상태를 반환했지만 라벨과 음성 준비도 증거가 없습니다. 상태를 새로고침하거나 다시 분석하세요.',
    recommendedAction: 'retry_workflow',
    actionLabel: '상태 확인 후 재시도',
    errorCode: 'missing_readiness_evidence',
  };
}

function hostedWorkflow(workflow: RemoteBookAIWorkflow): BookAnalysisWorkflow {
  const ttsReadiness = recordValue(recordValue(workflow.progress)?.ttsReadiness);
  const explicitReady = ttsReadiness?.ok === true;
  const reviewItems = buildBookAIWorkflowReviewItems(workflow);
  const needsReview = workflow.status === 'needs_review' || workflow.stage === 'needs_review';
  const completedWithoutEvidence = workflow.status === 'succeeded' && !explicitReady;
  return {
    ...workflow,
    runtime: 'hosted',
    readiness: explicitReady
      ? { outcome: 'ready_for_tts', reviewItems: [] }
      : needsReview || completedWithoutEvidence
        ? {
            outcome: 'needs_review',
            reviewItems: reviewItems.length > 0 ? reviewItems : [missingReadinessEvidence()],
          }
        : { outcome: 'pending', reviewItems: [] },
  };
}

export class RemoteBookAnalysisWorkflowGateway implements BookAnalysisWorkflowGateway {
  readonly runtime = 'hosted' as const;
  readonly supportsTTSCacheReadiness = true;

  constructor(private readonly client: RemoteApiClient) {}

  async getPlan(
    bookId: string,
    options: BookAIWorkflowPlanOptions = {},
    _signal?: AbortSignal,
  ): Promise<BookAnalysisWorkflow['plan']> {
    return (await this.client.getBookAIWorkflowPlan(bookId, options)).plan;
  }

  async start(input: StartBookAnalysisWorkflowInput): Promise<BookAnalysisWorkflow> {
    return hostedWorkflow(await this.startRemote(input));
  }

  async get(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    return hostedWorkflow((await this.client.getBookAIWorkflow(workflowId, signal)).workflow);
  }

  async retry(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    return hostedWorkflow((await this.client.retryBookAIWorkflow(workflowId, signal)).workflow);
  }

  async cancel(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    return hostedWorkflow((await this.client.cancelBookAIWorkflow(workflowId, signal)).workflow);
  }

  async refreshTTSCacheReadiness(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    return hostedWorkflow((await this.client.refreshBookAIWorkflowTTSCacheReadiness(workflowId, signal)).workflow);
  }

  async listReviews(workflowId: string, signal?: AbortSignal): Promise<readonly ChapterLabelAnalysisReviewArtifact[]> {
    return (await this.client.listBookAIWorkflowReviews(workflowId, signal)).reviews;
  }

  async saveReviewDraft(
    reviewId: string,
    expectedReviewRevision: number,
    candidate: ChapterLabelAnalysisReviewArtifact['candidate'],
    signal?: AbortSignal,
    editIntents: AnalysisReviewEditIntentMap = {},
  ): Promise<ChapterLabelAnalysisReviewArtifact> {
    return (
      await this.client.saveAnalysisReviewDraft(reviewId, { expectedReviewRevision, candidate, editIntents }, signal)
    ).review;
  }

  async rejectReview(
    reviewId: string,
    expectedReviewRevision: number,
    reason?: string,
    signal?: AbortSignal,
  ): Promise<ChapterLabelAnalysisReviewArtifact> {
    return (await this.client.rejectAnalysisReviewArtifact(reviewId, { expectedReviewRevision, reason }, signal))
      .review;
  }

  async approveReview(
    reviewId: string,
    expectedReviewRevision: number,
    signal?: AbortSignal,
  ): Promise<ChapterLabelAnalysisReviewArtifact> {
    return (await this.client.approveAnalysisReviewArtifact(reviewId, expectedReviewRevision, signal)).review;
  }

  private async startRemote(input: StartBookAnalysisWorkflowInput): Promise<RemoteBookAIWorkflow> {
    const { providerOptions: _providerOptions, ...remoteInput } = input;
    return (await this.client.startBookAIWorkflow(remoteInput)).workflow;
  }
}
