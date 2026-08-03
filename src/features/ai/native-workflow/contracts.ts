import type { ProviderExecutionMetadata } from '../../../providers/provider-execution';
import type { ApplyLabelCorrectionsCommandV2 } from '../../../providers/label-mutation-contract';
import type { NativeAnalysisReviewPromotionCommand } from '../../../storage/native-analysis-workflow';

export type NativeLabelMutationSagaCommand = ApplyLabelCorrectionsCommandV2 | NativeAnalysisReviewPromotionCommand;

export type NativeWorkflowStage =
  'character_graph_bootstrap' | 'character_graph_merge' | 'chapter_labeling' | 'tts_ready_preparation';

export type NativeWorkflowStatus =
  'queued' | 'waiting_for_input' | 'running' | 'failed' | 'needs_review' | 'succeeded' | 'cancelled';

export type NativeWorkflowJobStatus = 'queued' | 'waiting_for_input' | 'running' | 'failed' | 'succeeded' | 'cancelled';

export type NativeWorkflowJobType =
  'character_bundle_analysis' | 'character_graph_merge' | 'chapter_segment_labeling' | 'speaker_attribution_v3';

export interface NativeStructuredJsonRequest {
  readonly providerId: string;
  readonly modelId: string;
  readonly prompt: string;
  readonly responseSchema: unknown;
  readonly jsonSchemaName: string;
  readonly schemaVersion?: string;
  readonly providerOptions?: Readonly<Record<string, unknown>> | null;
}

export interface NativeBookWorkflowJobRequest {
  readonly id: string;
  readonly request?: NativeStructuredJsonRequest | null;
  readonly jobType?: NativeWorkflowJobType;
  readonly contractFingerprint?: string;
}

export interface NativeBookWorkflowStageRequest {
  readonly stage: NativeWorkflowStage;
  readonly jobs: readonly NativeBookWorkflowJobRequest[];
}

export interface NativeBookWorkflowSubmitRequest {
  readonly schemaVersion?: 2 | 3;
  readonly idempotencyKey: string;
  readonly novelId: string;
  readonly contentRevision: string;
  readonly planHash: string;
  readonly stages: readonly NativeBookWorkflowStageRequest[];
}

export interface NativeStructuredJsonBatchUnit {
  readonly id: string;
  readonly packetFingerprint: string;
  readonly request: NativeStructuredJsonRequest;
}

export interface NativeStructuredJsonBatch {
  readonly version: 'native-structured-json-batch-v1';
  readonly units: readonly NativeStructuredJsonBatchUnit[];
}

interface NativeBookWorkflowMaterializeRequestCommon {
  readonly workflowId: string;
  readonly jobId: string;
  readonly expectedFence: number;
}

export type NativeBookWorkflowMaterializeRequest = NativeBookWorkflowMaterializeRequestCommon &
  (
    | {
        readonly request: NativeStructuredJsonRequest;
        readonly batch?: never;
      }
    | {
        readonly request?: never;
        readonly batch: NativeStructuredJsonBatch;
      }
  );

export type NativeWorkflowReadinessOutcome = 'ready_for_tts' | 'needs_review';

export interface NativeBookWorkflowFinalizeRequest {
  readonly workflowId: string;
  readonly expectedFence: number;
  readonly outcome: NativeWorkflowReadinessOutcome;
  readonly reviewItems: readonly unknown[];
}

export interface NativeBookWorkflowReviewRequest {
  readonly workflowId: string;
  readonly expectedFence: number;
  readonly errorCode: string;
  readonly reviewItems: readonly unknown[];
}

export interface NativeLabelMutationPrepareRequest {
  readonly workflowId: string;
  readonly expectedFence: number;
  readonly operationId: string;
  readonly commandHash: string;
  readonly command: NativeLabelMutationSagaCommand;
}

export interface NativeLabelMutationFinalizeRequest {
  readonly workflowId: string;
  readonly expectedFence: number;
  readonly operationId: string;
  readonly commandHash: string;
  readonly receiptHash: string;
  readonly resumeAfterReview?: boolean;
}

export interface NativeLabelMutationPendingView {
  readonly operationId: string;
  readonly commandHash: string;
  readonly command: NativeLabelMutationSagaCommand;
}

export interface NativeLabelMutationReceiptView {
  readonly operationId: string;
  readonly commandHash: string;
  readonly receiptHash: string;
}

export interface NativeBookWorkflowJobView {
  readonly id: string;
  readonly stage: NativeWorkflowStage;
  readonly sequence: number;
  readonly status: NativeWorkflowJobStatus;
  readonly attempt: number;
  readonly jobType?: NativeWorkflowJobType;
  readonly contractFingerprint?: string;
  readonly requestHash?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly errorCode: string | null;
}

export interface NativeWorkflowCheckpointView {
  readonly jobId: string;
  readonly stage: NativeWorkflowStage;
  readonly sequence: number;
  readonly requestHash: string;
  readonly outputHash: string;
  readonly jobType?: NativeWorkflowJobType;
  readonly contractFingerprint?: string;
  readonly providerExecution?: ProviderExecutionMetadata;
  readonly completedAtMs: number;
}

export interface NativeWorkflowCheckpointRequest {
  readonly workflowId: string;
  readonly jobId: string;
}

export interface NativeWorkflowActiveRequest {
  readonly novelId: string;
  readonly contentRevision: string;
}

export interface NativeWorkflowCheckpointResult {
  readonly workflowId: string;
  readonly jobId: string;
  readonly requestHash: string;
  readonly outputHash: string;
  readonly jobType?: NativeWorkflowJobType;
  readonly contractFingerprint?: string;
  readonly output: unknown;
  readonly providerExecution?: ProviderExecutionMetadata;
}

export interface NativeBookWorkflowView {
  readonly schemaVersion: number;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly novelId: string;
  readonly contentRevision: string;
  readonly planHash: string;
  readonly payloadHash: string;
  readonly status: NativeWorkflowStatus;
  readonly currentStage: NativeWorkflowStage | null;
  readonly fence: number;
  readonly jobs: readonly NativeBookWorkflowJobView[];
  readonly checkpoints: readonly NativeWorkflowCheckpointView[];
  readonly readinessOutcome: NativeWorkflowReadinessOutcome | null;
  readonly reviewItems: readonly unknown[];
  readonly errorCode: string | null;
  readonly pendingLabelMutation?: NativeLabelMutationPendingView;
  readonly lastLabelMutationReceipt?: NativeLabelMutationReceiptView;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface NativeBookWorkflowBridge {
  submit(request: NativeBookWorkflowSubmitRequest): Promise<NativeBookWorkflowView>;
  get(workflowId: string): Promise<NativeBookWorkflowView>;
  getActive(request: NativeWorkflowActiveRequest): Promise<NativeBookWorkflowView | undefined>;
  materialize(request: NativeBookWorkflowMaterializeRequest): Promise<NativeBookWorkflowView>;
  finalize(request: NativeBookWorkflowFinalizeRequest): Promise<NativeBookWorkflowView>;
  requireReview(request: NativeBookWorkflowReviewRequest): Promise<NativeBookWorkflowView>;
  resume(workflowId: string): Promise<NativeBookWorkflowView>;
  cancel(workflowId: string): Promise<NativeBookWorkflowView>;
  checkpoint(request: NativeWorkflowCheckpointRequest): Promise<NativeWorkflowCheckpointResult>;
  prepareLabelMutation?(request: NativeLabelMutationPrepareRequest): Promise<NativeBookWorkflowView>;
  finalizeLabelMutation?(request: NativeLabelMutationFinalizeRequest): Promise<NativeBookWorkflowView>;
}
