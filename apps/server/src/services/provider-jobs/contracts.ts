import type { AIProvider } from '../../../../../src/providers/ai';
import type { ChapterLabelingValidationSummary } from '../../../../../src/providers/chapter-labeling-validator';
import type { TTSSynthesisProvider } from '../../../../../src/providers/tts';
import type { TTSRenderSpec } from '../../../../../src/providers/tts-render-spec';
import type { createS3Client, putTtsAudioObject } from '../object-storage.js';

export type ProviderJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type ProviderJobStage =
  | 'queued'
  | 'loading_bundle'
  | 'loading_chapter'
  | 'loading_graph'
  | 'analyzing_bundle'
  | 'labeling_segments'
  | 'loading_speaker_snapshot'
  | 'attributing_speakers'
  | 'decoding_speaker_sequence'
  | 'escalating_speakers'
  | 'routing_speaker_review'
  | 'merging_graph'
  | 'repairing_labels'
  | 'repair_candidate_ready'
  | 'writing_results'
  | 'loading_tts_input'
  | 'synthesizing_tts'
  | 'writing_tts_cache'
  | 'ready'
  | 'stale'
  | 'cancelled'
  | 'failed';

export interface ProviderJobExecutionIdentity {
  readonly attemptId: string;
  readonly bullmqJobId: string;
  readonly attemptGeneration?: number;
  readonly leaseOwner?: string;
  readonly leaseTokenHash?: string;
}

export interface ProviderJobRow {
  id: string;
  user_id: string;
  book_id: string;
  chapter_id: string | null;
  job_type: string;
  provider_id: string;
  model_id: string | null;
  input_hash: string;
  status: ProviderJobStatus;
  progress: unknown;
  current_attempt_id?: string | null;
  attempt_count?: number | string;
  analysis_input_revision_id?: string | null;
  execution?: ProviderJobExecutionIdentity;
}

export interface ProviderJobServiceDeps {
  readonly createAIProvider?: (input: {
    providerId: string;
    modelId?: string | null;
    providerOptions?: Record<string, unknown>;
  }) => AIProvider;
  readonly createTTSProvider?: (input: { providerId: string; modelId?: string | null }) => TTSSynthesisProvider;
  readonly s3Client?: ReturnType<typeof createS3Client>;
  readonly putTtsAudioObject?: typeof putTtsAudioObject;
  readonly cancellationPollMs?: number;
  readonly beforeProviderDispatch?: () => Promise<void>;
}

export interface ProviderJobProgressPatch {
  status?: ProviderJobStatus;
  stage?: ProviderJobStage;
  progress?: Record<string, unknown>;
  mergeProgress?: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: boolean;
  finishedAt?: boolean;
}

export interface TTSCacheProgress {
  cacheKey: string;
  voiceProfileId: string;
  speakerId: string;
  segmentIds: string[];
  inputTextHash: string;
  optionsHash: string;
  renderSpec?: TTSRenderSpec;
  renderSpecHash?: string;
  renderPlanId?: string;
  renderItemId?: string;
  sampleTextId?: string;
  cachePurpose: 'reading' | 'voice_sample';
  providerOptions: Record<string, unknown>;
}

export interface TTSSegmentTextRow {
  id: string;
  paragraph_id: string;
  segment_index: number;
  start_offset: number;
  end_offset: number;
  segment_text_hash: string;
  speaker_id: string;
  emotion: string;
  text: string;
}

export interface ProviderRequestProfile {
  id: string;
  promptVersion: string;
  schemaVersion: string;
  responseSchema?: unknown;
}

export class ChapterLabelingValidationError extends Error {
  constructor(
    message: string,
    readonly validation: ChapterLabelingValidationSummary | undefined,
    readonly quality?: import('../../../../../src/providers/chapter-labeling-quality').ChapterLabelingQualitySummary,
  ) {
    super(message);
    this.name = 'ChapterLabelingValidationError';
  }
}

export class ProviderJobCancelledError extends Error {
  constructor(jobId: string) {
    super(`Provider job cancelled: ${jobId}`);
    this.name = 'ProviderJobCancelledError';
  }
}
