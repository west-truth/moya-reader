import type { ProviderJobAdmissionLimit } from '../provider-job-admission/index.js';

export type ProviderJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface BookAIWorkflowRow {
  id: string;
  user_id: string;
  book_id: string;
  provider_id: string;
  model_id: string | null;
  plan_hash: string;
  plan: unknown;
  content_revision_id: string;
  base_graph_revision_id: string | null;
  revision_fence: number;
  status: string;
  stage: string;
  progress: unknown;
}

export interface WorkflowProviderJobLinkRow {
  id: string;
  workflow_id: string;
  provider_job_id: string;
  stage: string;
  plan_item_id: string;
  sequence: number;
  job_type: string;
  provider_id: string;
  model_id: string | null;
  input_hash: string;
  status: ProviderJobStatus;
  progress: unknown;
  error_code: string | null;
  error_message: string | null;
  current_attempt_id?: string | null;
  analysis_input_revision_id?: string | null;
}

export interface ChapterSeedRow {
  id: string;
  text_hash: string;
  updated_at: Date | string;
  paragraph_count: number | string;
  character_count: number | string;
}

export interface TTSReadinessMetricsRow {
  segment_count: number | string;
  labeled_chapter_count: number | string;
  labeled_planned_paragraph_count: number | string;
  unknown_segment_count: number | string;
  low_confidence_segment_count: number | string;
  character_speaker_count: number | string;
}

export interface TTSReadinessMissingSpeakerRow {
  speaker_id: string;
}

export interface TTSReadinessRoleProfileRow {
  role: string;
  profile_count: number | string;
}

export interface TTSReadinessMissingParagraphRow {
  paragraph_id: string;
}

export interface TTSReadinessReport {
  ok: boolean;
  errorCode?: string;
  message?: string;
  metrics: {
    plannedChapterCount: number;
    segmentCount: number;
    labeledChapterCount: number;
    plannedParagraphCount: number;
    labeledPlannedParagraphCount: number;
    missingPlannedParagraphCount: number;
    unknownSegmentCount: number;
    lowConfidenceSegmentCount: number;
    characterSpeakerCount: number;
    unknownSegmentRatio: number;
    missingCharacterVoiceProfileCount: number;
    narratorProfileCount: number;
    systemProfileCount: number;
    unknownProfileCount: number;
  };
  missingCharacterVoiceSpeakerIds: string[];
  missingPlannedParagraphIds: string[];
  checkedAt: string;
}

export interface TTSCacheCoverageRow {
  cacheable_segment_count: number | string;
  cached_segment_count: number | string;
}

export interface TTSCacheSummaryRow {
  cache_item_count: number | string;
  cached_byte_size: number | string;
}

export interface TTSCacheMissingSegmentRow {
  segment_id: string;
}

export interface TTSCacheReadinessReport {
  ok: boolean;
  errorCode?: string;
  message?: string;
  metrics: {
    plannedChapterCount: number;
    cacheableSegmentCount: number;
    cachedSegmentCount: number;
    missingCachedSegmentCount: number;
    cacheItemCount: number;
    cachedByteSize: number;
    cacheReadyRatio: number;
  };
  missingCachedSegmentIds: string[];
  checkedAt: string;
}

export interface WorkflowReviewTarget {
  readonly id: string;
  readonly kind:
    | 'failed_child_job'
    | 'missing_paragraph_labels'
    | 'missing_voice_profiles'
    | 'high_unknown_speaker_ratio'
    | 'tts_readiness_failed'
    | 'provider_admission_rejected';
  readonly stage: string;
  readonly planItemId?: string;
  readonly providerJobId?: string;
  readonly providerJobStatus?: ProviderJobStatus;
  readonly jobType?: string;
  readonly chapterId?: string;
  readonly labelingWindowIds?: string[];
  readonly paragraphIds?: string[];
  readonly speakerIds?: string[];
  readonly errorCode?: string;
  readonly message?: string;
  readonly limit?: ProviderJobAdmissionLimit;
  readonly retryAfterSeconds?: number;
  readonly recommendedAction:
    | 'inspect_failed_job'
    | 'retry_labeling_windows'
    | 'assign_voice_profiles'
    | 'review_labels'
    | 'retry_workflow'
    | 'retry_same_request'
    | 'open_manual_review';
  readonly repairMode?: 'auto_repair_on_validation_failure' | 'pinned_candidate_repair';
}

export interface BookSeedRow {
  normalized_text_hash: string;
  total_chapters: number | string;
  total_characters: number | string;
  total_paragraphs: number | string;
  updated_at?: Date | string;
}
