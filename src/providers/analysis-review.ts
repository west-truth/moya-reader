import type { Chapter, Paragraph } from '../domain/types';
import type { ChapterLabelingResult } from './ai';
import type { ChapterLabelingValidationIssue, ChapterLabelingValidationSummary } from './chapter-labeling-validator';
import type { ChapterLabelingQualityIssue, ChapterLabelingQualitySummary } from './chapter-labeling-quality';
import type { ProviderExecutionMetadata } from './provider-execution';
import type { LabelingContextHaloParagraph } from './labeling-context-packet';
import type { AnalysisReviewEditIntentMap } from './analysis-review-correction';

export type AnalysisReviewStatus =
  'open' | 'editing' | 'validating' | 'approved' | 'rejected' | 'obsolete' | 'promoting' | 'promoted';

export type AnalysisReviewDecisionAction = 'save_draft' | 'approve' | 'reject' | 'request_repair';

export interface AnalysisReviewCharacterOption {
  readonly id: string;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
}

export interface ChapterLabelAnalysisReviewArtifact {
  readonly id: string;
  readonly workflowId: string;
  readonly providerJobId: string;
  readonly inputRevisionId: string;
  readonly stagingArtifactId: string;
  readonly reviewKind: 'chapter_labeling';
  readonly windowId: string;
  readonly chapterId: string;
  readonly chapter: Chapter;
  readonly paragraphs: readonly Paragraph[];
  readonly haloParagraphs: readonly LabelingContextHaloParagraph[];
  readonly characterOptions: readonly AnalysisReviewCharacterOption[];
  readonly candidate: ChapterLabelingResult;
  readonly candidateHash: string;
  readonly originalCandidate: ChapterLabelingResult;
  readonly originalCandidateHash: string;
  readonly editIntents: AnalysisReviewEditIntentMap;
  readonly validationIssues: readonly ChapterLabelingValidationIssue[];
  readonly qualityIssues: readonly ChapterLabelingQualityIssue[];
  readonly validationSummary: ChapterLabelingValidationSummary;
  readonly qualitySummary: ChapterLabelingQualitySummary;
  readonly providerExecution?: ProviderExecutionMetadata;
  readonly status: AnalysisReviewStatus;
  readonly reviewRevision: number;
  readonly contentRevisionId: string;
  readonly revisionFence: number;
  readonly graphRevisionId?: string;
  readonly graphFingerprint: string;
  readonly correctionFingerprint: string;
  readonly promotedArtifactId?: string;
  readonly promotionAttemptCount?: number;
  readonly promotionLastErrorCode?: string;
  readonly promotionLastErrorAt?: string;
  readonly nextReconcileAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly promotedAt?: string;
  readonly expiresAt?: string;
}

export interface SaveChapterLabelReviewDraftInput {
  readonly expectedReviewRevision: number;
  readonly candidate: ChapterLabelingResult;
  readonly editIntents?: AnalysisReviewEditIntentMap;
}

export interface RejectAnalysisReviewInput {
  readonly expectedReviewRevision: number;
  readonly reason?: string;
}
