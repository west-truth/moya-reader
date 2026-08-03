import type { LabeledSegment } from '../../domain/types';
import type { ChapterLabelingResult, CharacterGraph } from '../../providers/ai';
import type { AnalysisReviewEditIntentMap } from '../../providers/analysis-review-correction';
import type { BookAIWorkflowPlan } from '../../providers/book-ai-workflow-plan';
import type { ProviderExecutionMetadata } from '../../providers/provider-execution';
import type { SpeakerSegmentProvenanceDraftV1 } from '../../providers/speaker-attribution/accepted-speaker-provenance';
import type { SpeakerRiskRouteV1 } from '../../providers/speaker-attribution/routing';
import type { SpeakerSequenceDecisionRecordV1 } from '../../providers/speaker-attribution/workflow-state';
import type { NativeLabelingContract } from './labeling-contract';

export type NativeAnalysisArtifactType = 'character_graph' | 'label_window';
export type NativeAnalysisStagingStatus = 'staged' | 'promoted' | 'stale' | 'quarantined';

export interface NativeAnalysisProviderDescriptor {
  readonly providerId: string;
  readonly modelId: string;
  readonly providerOptions: Readonly<Record<string, unknown>>;
}

export interface NativeAnalysisWorkflowDescriptorInput {
  readonly workflowId: string;
  readonly novelId: string;
  readonly contentRevisionId: string;
  readonly planHash: string;
  readonly plan: BookAIWorkflowPlan;
  readonly provider: NativeAnalysisProviderDescriptor;
  readonly labelingContract?: NativeLabelingContract;
}

export interface NativeAnalysisWorkflowDescriptor extends NativeAnalysisWorkflowDescriptorInput {
  readonly labelingContractFingerprint?: string;
  readonly descriptorFingerprint: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NativeAnalysisWorkflowJobPlan {
  readonly jobId: string;
  readonly artifactType: NativeAnalysisArtifactType;
  readonly chapterId?: string;
  readonly plannedParagraphIds: readonly string[];
}

export interface NativeAnalysisWorkflowFenceInput {
  readonly workflowId: string;
  readonly novelId: string;
  readonly contentRevisionId: string;
  readonly planHash: string;
  readonly fence: number;
  readonly jobs: readonly NativeAnalysisWorkflowJobPlan[];
}

export interface NativeAnalysisWorkflowFenceRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly novelId: string;
  readonly contentRevisionId: string;
  readonly planHash: string;
  readonly fence: number;
  readonly jobs: readonly NativeAnalysisWorkflowJobPlan[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NativeCharacterGraphArtifactPayload {
  readonly kind: 'character_graph';
  readonly graph: CharacterGraph;
}

export interface NativeSpeakerBatchDurableMetadataV1 {
  readonly version: 'native-speaker-batch-metadata-v1';
  readonly jobId: string;
  readonly packetFingerprints: readonly string[];
  readonly requestHashes: readonly string[];
  readonly outputHashes: readonly string[];
  readonly sequenceDecisionIds: readonly string[];
  readonly riskRoutes: readonly SpeakerRiskRouteV1[];
  readonly routedSpanCount: number;
  readonly pendingSpeakerEntityCount: number;
  readonly speakerProvenanceCount: number;
  readonly speakerProvenanceFingerprint: string;
  readonly providerExecutions: readonly ProviderExecutionMetadata[];
}

export interface NativeSpeakerWorkflowArtifactPayloadV1 {
  readonly version: 'native-speaker-workflow-artifact-v1';
  readonly sequenceRecords: readonly SpeakerSequenceDecisionRecordV1[];
  readonly speakerProvenanceDrafts: readonly SpeakerSegmentProvenanceDraftV1[];
  readonly artifactDependencyIds: readonly string[];
  readonly speakerEntityIdByCanonicalSpeakerId: Readonly<Record<string, string>>;
  readonly metadata: NativeSpeakerBatchDurableMetadataV1;
}

export interface NativeLabelWindowArtifactPayload {
  readonly kind: 'label_window';
  readonly chapterId: string;
  readonly segments: readonly LabeledSegment[];
  readonly result?: ChapterLabelingResult;
  readonly speakerWorkflow?: NativeSpeakerWorkflowArtifactPayloadV1;
}

export type NativeAnalysisArtifactPayload = NativeCharacterGraphArtifactPayload | NativeLabelWindowArtifactPayload;

interface StageNativeAnalysisOutputCommon {
  readonly workflowId: string;
  readonly jobId: string;
  readonly novelId: string;
  readonly workflowFence: number;
  readonly planHash: string;
  readonly expectedContentRevisionId: string;
  readonly expectedGraphFingerprint: string;
  readonly correctionFingerprint: string;
  readonly plannedParagraphIds: readonly string[];
  readonly outputHash: string;
}

export type StageNativeAnalysisOutputInput = StageNativeAnalysisOutputCommon &
  (
    | {
        readonly artifactType: 'character_graph';
        readonly chapterId?: undefined;
        readonly payload: NativeCharacterGraphArtifactPayload;
      }
    | {
        readonly artifactType: 'label_window';
        readonly chapterId: string;
        readonly payload: NativeLabelWindowArtifactPayload;
      }
  );

export interface NativeAnalysisStagedOutput extends StageNativeAnalysisOutputCommon {
  readonly id: string;
  readonly artifactType: NativeAnalysisArtifactType;
  readonly chapterId?: string;
  readonly payload: NativeAnalysisArtifactPayload;
  readonly status: NativeAnalysisStagingStatus;
  readonly staleReason?: string;
  readonly createdAt: string;
  readonly promotedAt?: string;
  readonly reviewDraft?: ChapterLabelingResult;
  readonly reviewEditIntents?: AnalysisReviewEditIntentMap;
  readonly reviewRevision?: number;
  readonly reviewStatus?: 'open' | 'editing' | 'rejected' | 'approved';
  readonly reviewUpdatedAt?: string;
  readonly reviewReason?: string;
}

export interface NativeAnalysisReviewPromotionCommand {
  readonly kind: 'native_review_promotion_v1';
  readonly operationId: string;
  readonly artifactId: string;
  readonly expectedReviewRevision: number;
  readonly candidateHash: string;
  readonly editIntentsHash: string;
  readonly approvedAt: string;
}

export interface NativeAnalysisPromotionSnapshot {
  readonly novelId: string;
  readonly chapterId?: string;
  readonly activeContentRevisionId: string;
  readonly graphFingerprint: string;
  readonly correctionFingerprint: string;
}

export interface NativeAnalysisPromotionProvenance {
  readonly id: string;
  readonly artifactId: string;
  readonly artifactType: NativeAnalysisArtifactType;
  readonly workflowId: string;
  readonly jobId: string;
  readonly novelId: string;
  readonly chapterId?: string;
  readonly contentRevisionId: string;
  readonly workflowFence: number;
  readonly planHash: string;
  readonly expectedGraphFingerprint: string;
  readonly correctionFingerprint: string;
  readonly plannedParagraphIds: readonly string[];
  readonly outputHash: string;
  readonly canonicalOutputFingerprint: string;
  readonly syncOutboxItemId: string;
  readonly syncEventId: string;
  readonly promotedAt: string;
}

export type NativeAnalysisPromotionResult =
  | {
      readonly status: 'promoted';
      readonly artifact: NativeAnalysisStagedOutput;
      readonly provenance: NativeAnalysisPromotionProvenance;
    }
  | {
      readonly status: 'already_promoted';
      readonly artifact: NativeAnalysisStagedOutput;
      readonly provenance: NativeAnalysisPromotionProvenance;
    }
  | { readonly status: 'stale' | 'rejected'; readonly artifact: NativeAnalysisStagedOutput; readonly reason: string };
