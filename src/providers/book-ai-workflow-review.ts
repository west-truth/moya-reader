export type BookAIWorkflowReviewSeverity = 'error' | 'warning';

export type BookAIWorkflowReviewKind =
  | 'failed_job'
  | 'provider_outcome_unknown'
  | 'cancelled_job'
  | 'missing_paragraph_labels'
  | 'missing_voice_profiles'
  | 'high_unknown_speaker_ratio'
  | 'workflow_error';

export type BookAIWorkflowReviewAction =
  | 'retry_workflow'
  | 'retry_same_request'
  | 'open_manual_review'
  | 'assign_voice_profiles'
  | 'review_labels'
  | 'inspect_failed_job'
  | 'resume_after_fix';

interface ReviewProviderJob {
  readonly id?: string;
  readonly chapterId?: string;
  readonly type?: string;
  readonly status?: string;
  readonly stage?: string;
  readonly progress?: unknown;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

interface ReviewWorkflowJob {
  readonly id?: string;
  readonly providerJobId?: string;
  readonly stage?: string;
  readonly planItemId?: string;
  readonly sequence?: number;
  readonly job?: ReviewProviderJob;
}

export interface BookAIWorkflowReviewWorkflow {
  readonly id?: string;
  readonly status?: string;
  readonly stage?: string;
  readonly progress?: unknown;
  readonly jobs?: readonly ReviewWorkflowJob[];
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface BookAIWorkflowReviewItem {
  readonly id: string;
  readonly kind: BookAIWorkflowReviewKind;
  readonly severity: BookAIWorkflowReviewSeverity;
  readonly title: string;
  readonly detail: string;
  readonly recommendedAction: BookAIWorkflowReviewAction;
  readonly actionLabel: string;
  readonly stage?: string;
  readonly providerJobId?: string;
  readonly chapterId?: string;
  readonly labelingWindowIds?: readonly string[];
  readonly paragraphIds?: readonly string[];
  readonly speakerIds?: readonly string[];
  readonly errorCode?: string;
  readonly repairMode?: string;
}

const LIST_PREVIEW_LIMIT = 8;
const MESSAGE_PREVIEW_LIMIT = 180;
const UNKNOWN_SPEAKER_REVIEW_RATIO = 0.25;

export function buildBookAIWorkflowReviewItems(
  workflow: BookAIWorkflowReviewWorkflow | undefined,
): BookAIWorkflowReviewItem[] {
  if (!workflow) return [];

  const items: BookAIWorkflowReviewItem[] = [];
  const jobs = Array.isArray(workflow.jobs) ? workflow.jobs : [];
  const progress = recordValue(workflow.progress);
  const reviewTargets = recordArrayValue(progress?.workflowReviewTargets);

  for (const workflowJob of jobs) {
    const job = workflowJob.job;
    if (!job || (job.status !== 'failed' && job.status !== 'cancelled')) continue;

    const progress = recordValue(job.progress);
    const sourceContext = recordValue(progress?.sourceContext);
    const paragraphIds = stringArrayValue(sourceContext?.paragraphIds);
    const chapterId = stringValue(sourceContext?.chapterId) || job.chapterId;
    const stage = workflowJob.stage || job.stage || stringValue(sourceContext?.workflowStage);
    const providerJobId = workflowJob.providerJobId || job.id;
    const reviewTarget = providerJobId
      ? reviewTargets.find((target) => stringValue(target.providerJobId) === providerJobId)
      : undefined;
    const repairMode = stringValue(reviewTarget?.repairMode);
    const outcomeUnknown = job.errorCode === 'provider_attempt_outcome_unknown';
    const label = outcomeUnknown
      ? 'Provider 결과 확인 불가'
      : job.status === 'cancelled'
        ? '취소된 provider job'
        : '실패한 provider job';
    const action =
      job.type === 'chapter_label_repair'
        ? 'retry_same_request'
        : job.status === 'cancelled'
          ? 'resume_after_fix'
          : 'inspect_failed_job';
    const detailParts = [
      stage ? `stage ${stage}` : undefined,
      chapterId ? `chapter ${chapterId}` : undefined,
      workflowJob.planItemId ? `plan ${workflowJob.planItemId}` : undefined,
      paragraphIds.length > 0 ? `paragraphs ${previewList(paragraphIds)}` : undefined,
      repairMode ? `retry repair ${repairMode}` : undefined,
      outcomeUnknown ? '요청이 처리되었거나 과금되었을 수 있어 자동 재호출하지 않습니다.' : undefined,
      job.errorCode ? `code ${job.errorCode}` : undefined,
      job.errorMessage ? truncateText(job.errorMessage, MESSAGE_PREVIEW_LIMIT) : undefined,
    ].filter(Boolean);

    items.push({
      id: `${job.status}_job:${providerJobId || workflowJob.id || items.length}`,
      kind: outcomeUnknown ? 'provider_outcome_unknown' : job.status === 'cancelled' ? 'cancelled_job' : 'failed_job',
      severity: job.status === 'cancelled' ? 'warning' : 'error',
      title: label,
      detail: detailParts.join(' · ') || '작업 상태와 provider 응답을 확인해야 합니다.',
      recommendedAction: action,
      actionLabel: outcomeUnknown
        ? '중복 비용 가능성 확인 후 재시도 결정'
        : job.type === 'chapter_label_repair'
          ? '동일 repair 요청 재시도'
          : job.status === 'cancelled'
            ? '원인 확인 후 workflow 재시도'
            : '실패 원인 확인 후 재시도',
      stage,
      providerJobId,
      chapterId,
      paragraphIds,
      errorCode: job.errorCode,
      repairMode,
    });
  }

  const readiness = recordValue(progress?.ttsReadiness);
  const readinessMetrics = recordValue(readiness?.metrics);
  const missingParagraphIds = stringArrayValue(readiness?.missingPlannedParagraphIds);
  const missingParagraphCount =
    numberValue(readinessMetrics?.missingPlannedParagraphCount) ?? missingParagraphIds.length;
  const missingSpeakerIds = stringArrayValue(readiness?.missingCharacterVoiceSpeakerIds);
  const missingVoiceCount =
    numberValue(readinessMetrics?.missingCharacterVoiceProfileCount) ?? missingSpeakerIds.length;
  const unknownRatio = numberValue(readinessMetrics?.unknownSegmentRatio) ?? 0;
  const readinessErrorCode = stringValue(readiness?.errorCode);
  const missingParagraphTarget = reviewTargets.find(
    (target) => stringValue(target.kind) === 'missing_paragraph_labels',
  );
  const missingLabelingWindowIds = stringArrayValue(missingParagraphTarget?.labelingWindowIds);
  const missingParagraphRepairMode = stringValue(missingParagraphTarget?.repairMode);
  const missingParagraphWindowSuffix =
    missingLabelingWindowIds.length > 0 ? ` retry windows ${previewList(missingLabelingWindowIds)}` : '';

  if (
    missingParagraphIds.length > 0 ||
    missingParagraphCount > 0 ||
    readinessErrorCode === 'tts_readiness_missing_paragraphs'
  ) {
    items.push({
      id: 'tts_readiness:missing_paragraph_labels',
      kind: 'missing_paragraph_labels',
      severity: 'error',
      title: '라벨이 없는 예정 문단',
      detail:
        missingParagraphIds.length > 0
          ? `${previewList(missingParagraphIds)} 문단의 화자/감정 라벨이 비어 있습니다.${missingParagraphWindowSuffix}`
          : `${missingParagraphCount}개 예정 문단의 화자/감정 라벨이 비어 있습니다.${missingParagraphWindowSuffix}`,
      recommendedAction: 'retry_workflow',
      actionLabel: '누락 라벨 재생성',
      labelingWindowIds: missingLabelingWindowIds,
      paragraphIds: missingParagraphIds,
      errorCode: readinessErrorCode,
      repairMode: missingParagraphRepairMode,
    });
  }

  if (
    missingSpeakerIds.length > 0 ||
    missingVoiceCount > 0 ||
    readinessErrorCode === 'tts_readiness_missing_voice_profiles'
  ) {
    items.push({
      id: 'tts_readiness:missing_voice_profiles',
      kind: 'missing_voice_profiles',
      severity: 'warning',
      title: '캐릭터별 TTS 음성 미지정',
      detail:
        missingSpeakerIds.length > 0
          ? `${previewList(missingSpeakerIds)} 캐릭터에 사용할 음성이 없습니다.`
          : `${missingVoiceCount}명 캐릭터에 사용할 음성이 없습니다.`,
      recommendedAction: 'assign_voice_profiles',
      actionLabel: 'TTS 탭에서 음성 배정',
      speakerIds: missingSpeakerIds,
      errorCode: readinessErrorCode,
    });
  }

  if (
    unknownRatio > UNKNOWN_SPEAKER_REVIEW_RATIO ||
    readinessErrorCode === 'tts_readiness_unknown_speaker_ratio_high'
  ) {
    items.push({
      id: 'tts_readiness:high_unknown_speaker_ratio',
      kind: 'high_unknown_speaker_ratio',
      severity: 'warning',
      title: '알 수 없는 화자 비율 높음',
      detail: `unknown speaker segment 비율이 ${Math.round(unknownRatio * 100)}%입니다.`,
      recommendedAction: 'review_labels',
      actionLabel: '라벨 검토 후 재시도',
      errorCode: readinessErrorCode,
    });
  }

  if (workflow.errorMessage && !items.some((item) => item.kind === 'failed_job')) {
    items.push({
      id: 'workflow:error',
      kind: 'workflow_error',
      severity: 'error',
      title: 'Workflow 오류',
      detail: truncateText(workflow.errorMessage, MESSAGE_PREVIEW_LIMIT),
      recommendedAction: 'retry_workflow',
      actionLabel: '원인 확인 후 재시도',
      errorCode: workflow.errorCode,
    });
  }

  if (items.length === 0 && (workflow.status === 'needs_review' || workflow.stage === 'needs_review')) {
    items.push({
      id: 'workflow:needs_review',
      kind: 'workflow_error',
      severity: 'warning',
      title: '검토가 필요한 workflow',
      detail: '서버가 검토 상태를 반환했지만 구체적인 원인 항목이 없습니다. 상태 새로고침 후 workflow를 재시도하세요.',
      recommendedAction: 'retry_workflow',
      actionLabel: '상태 확인 후 재시도',
      errorCode: workflow.errorCode,
    });
  }

  return dedupeReviewItems(items);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function recordArrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function previewList(values: readonly string[]): string {
  const visible = values.slice(0, LIST_PREVIEW_LIMIT);
  const suffix = values.length > visible.length ? ` 외 ${values.length - visible.length}개` : '';
  return `${visible.join(', ')}${suffix}`;
}

function truncateText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value;
}

function dedupeReviewItems(items: readonly BookAIWorkflowReviewItem[]): BookAIWorkflowReviewItem[] {
  const seen = new Set<string>();
  const result: BookAIWorkflowReviewItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}
