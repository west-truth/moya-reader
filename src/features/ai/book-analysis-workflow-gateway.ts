import type { BookAIWorkflowPlan, BookAIWorkflowPlanOptions } from '../../providers/book-ai-workflow-plan';
import type { BookAIWorkflowReviewItem } from '../../providers/book-ai-workflow-review';
import type { ProviderJob } from '../../providers/provider-jobs';
import type { JsonValue } from '../../sync/types';
import type { ChapterLabelAnalysisReviewArtifact } from '../../providers/analysis-review';
import type { AnalysisReviewEditIntentMap } from '../../providers/analysis-review-correction';

export type BookAnalysisWorkflowRuntime = 'hosted' | 'native';
export type BookAnalysisWorkflowReadinessOutcome = 'pending' | 'ready_for_tts' | 'needs_review';

export class BookAnalysisWorkflowNotFoundError extends Error {
  constructor(workflowId: string) {
    super(`Book analysis workflow not found: ${workflowId}`);
    this.name = 'BookAnalysisWorkflowNotFoundError';
  }
}

export interface BookAnalysisWorkflowReadiness {
  readonly outcome: BookAnalysisWorkflowReadinessOutcome;
  readonly reviewItems: readonly BookAIWorkflowReviewItem[];
}

export interface BookAnalysisWorkflowProviderJob extends ProviderJob {
  readonly stage?: string;
  readonly progress?: JsonValue;
}

export interface BookAnalysisWorkflowJob {
  readonly id: string;
  readonly workflowId: string;
  readonly providerJobId?: string;
  readonly stage: string;
  readonly planItemId: string;
  readonly sequence: number;
  readonly job?: BookAnalysisWorkflowProviderJob;
  readonly createdAt: string;
}

export interface BookAnalysisWorkflow {
  readonly id: string;
  readonly novelId: string;
  readonly workflowType: string;
  readonly runtime: BookAnalysisWorkflowRuntime;
  readonly providerId: string;
  readonly modelId?: string;
  readonly planHash: string;
  readonly plan: BookAIWorkflowPlan;
  readonly status: string;
  readonly stage: string;
  readonly readiness: BookAnalysisWorkflowReadiness;
  readonly progress?: JsonValue;
  readonly jobs: readonly BookAnalysisWorkflowJob[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface StartBookAnalysisWorkflowInput {
  readonly bookId: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
  readonly planOptions?: BookAIWorkflowPlanOptions;
  readonly force?: boolean;
}

export interface BookAnalysisWorkflowGateway {
  readonly runtime: BookAnalysisWorkflowRuntime;
  readonly supportsTTSCacheReadiness: boolean;
  getPlan(bookId: string, options?: BookAIWorkflowPlanOptions, signal?: AbortSignal): Promise<BookAIWorkflowPlan>;
  start(input: StartBookAnalysisWorkflowInput, signal?: AbortSignal): Promise<BookAnalysisWorkflow>;
  get(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow>;
  getActive?(bookId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow | undefined>;
  retry(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow>;
  cancel(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow>;
  refreshTTSCacheReadiness?(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow>;
  listReviews?(workflowId: string, signal?: AbortSignal): Promise<readonly ChapterLabelAnalysisReviewArtifact[]>;
  saveReviewDraft?(
    reviewId: string,
    expectedReviewRevision: number,
    candidate: ChapterLabelAnalysisReviewArtifact['candidate'],
    signal?: AbortSignal,
    editIntents?: AnalysisReviewEditIntentMap,
  ): Promise<ChapterLabelAnalysisReviewArtifact>;
  rejectReview?(
    reviewId: string,
    expectedReviewRevision: number,
    reason?: string,
    signal?: AbortSignal,
  ): Promise<ChapterLabelAnalysisReviewArtifact>;
  approveReview?(
    reviewId: string,
    expectedReviewRevision: number,
    signal?: AbortSignal,
  ): Promise<ChapterLabelAnalysisReviewArtifact>;
}
