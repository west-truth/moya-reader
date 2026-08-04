import { describe, expect, it } from 'vitest';
import { buildBookAIWorkflowReviewItems } from '../providers/book-ai-workflow-review';

describe('buildBookAIWorkflowReviewItems', () => {
  it('warns before retrying a provider attempt with an unknown outcome', () => {
    const items = buildBookAIWorkflowReviewItems({
      id: 'workflow_1',
      status: 'needs_review',
      jobs: [
        {
          providerJobId: 'job_1',
          stage: 'labeling_chapters',
          job: {
            id: 'job_1',
            status: 'failed',
            errorCode: 'provider_attempt_outcome_unknown',
            errorMessage: 'Provider request outcome is unknown; automatic retry is blocked',
          },
        },
      ],
    });

    expect(items[0]).toMatchObject({
      kind: 'provider_outcome_unknown',
      title: 'Provider 결과 확인 불가',
      recommendedAction: 'inspect_failed_job',
      actionLabel: '중복 비용 가능성 확인 후 재시도 결정',
    });
    expect(items[0]?.detail).toContain('과금되었을 수 있어 자동 재호출하지 않습니다');
  });

  it('surfaces missing planned paragraph labels and missing character voices separately', () => {
    const items = buildBookAIWorkflowReviewItems({
      id: 'workflow_1',
      status: 'needs_review',
      stage: 'needs_review',
      progress: {
        workflowReviewTargets: [
          {
            id: 'tts_readiness:missing_paragraph_labels',
            kind: 'missing_paragraph_labels',
            labelingWindowIds: ['window_1', 'window_2'],
            paragraphIds: ['p1', 'p2'],
            repairMode: 'auto_repair_on_validation_failure',
          },
        ],
        ttsReadiness: {
          ok: false,
          errorCode: 'tts_readiness_missing_paragraphs',
          missingPlannedParagraphIds: ['p1', 'p2'],
          missingCharacterVoiceSpeakerIds: ['character_1'],
          metrics: {
            missingPlannedParagraphCount: 2,
            missingCharacterVoiceProfileCount: 1,
            unknownSegmentRatio: 0.05,
          },
        },
      },
    });

    expect(items.map((item) => item.kind)).toEqual(['missing_paragraph_labels', 'missing_voice_profiles']);
    expect(items[0]).toMatchObject({
      severity: 'error',
      recommendedAction: 'retry_workflow',
      labelingWindowIds: ['window_1', 'window_2'],
      paragraphIds: ['p1', 'p2'],
      repairMode: 'auto_repair_on_validation_failure',
    });
    expect(items[1]).toMatchObject({
      severity: 'warning',
      recommendedAction: 'assign_voice_profiles',
      speakerIds: ['character_1'],
    });
  });

  it('extracts failed labeling job context from provider job progress', () => {
    const items = buildBookAIWorkflowReviewItems({
      id: 'workflow_1',
      status: 'needs_review',
      stage: 'labeling_chapters',
      progress: {
        workflowReviewTargets: [
          {
            id: 'failed_child_job:job_1',
            kind: 'failed_child_job',
            providerJobId: 'job_1',
            repairMode: 'auto_repair_on_validation_failure',
          },
        ],
      },
      jobs: [
        {
          id: 'workflow_job_1',
          providerJobId: 'job_1',
          stage: 'labeling_chapters',
          planItemId: 'label_window_4',
          sequence: 4,
          job: {
            id: 'job_1',
            status: 'failed',
            type: 'chapter_segment_labeling',
            errorCode: 'provider_schema_invalid',
            errorMessage: 'The response did not match the labeling schema.',
            progress: {
              sourceContext: {
                workflowStage: 'labeling_chapters',
                chapterId: 'chapter_7',
                labelingWindowId: 'label_window_4',
                paragraphIds: ['p10', 'p11', 'p12'],
              },
            },
          },
        },
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'failed_job',
      severity: 'error',
      providerJobId: 'job_1',
      stage: 'labeling_chapters',
      chapterId: 'chapter_7',
      paragraphIds: ['p10', 'p11', 'p12'],
      errorCode: 'provider_schema_invalid',
      recommendedAction: 'inspect_failed_job',
      repairMode: 'auto_repair_on_validation_failure',
    });
    expect(items[0].detail).toContain('chapter chapter_7');
    expect(items[0].detail).toContain('paragraphs p10, p11, p12');
  });

  it('flags high unknown speaker ratio even when no provider job failed', () => {
    const items = buildBookAIWorkflowReviewItems({
      id: 'workflow_1',
      status: 'needs_review',
      stage: 'ready_for_tts',
      progress: {
        ttsReadiness: {
          ok: false,
          errorCode: 'tts_readiness_unknown_speaker_ratio_high',
          metrics: {
            unknownSegmentRatio: 0.42,
          },
        },
      },
    });

    expect(items).toEqual([
      expect.objectContaining({
        kind: 'high_unknown_speaker_ratio',
        severity: 'warning',
        recommendedAction: 'review_labels',
      }),
    ]);
  });

  it('adds a generic review item for a needs_review workflow without details', () => {
    expect(
      buildBookAIWorkflowReviewItems({
        id: 'workflow_1',
        status: 'needs_review',
        stage: 'needs_review',
      }),
    ).toEqual([
      expect.objectContaining({
        kind: 'workflow_error',
        severity: 'warning',
        recommendedAction: 'retry_workflow',
      }),
    ]);
  });

  it('reports cancelled child jobs as resumable warnings', () => {
    const items = buildBookAIWorkflowReviewItems({
      id: 'workflow_1',
      status: 'needs_review',
      stage: 'cancelled',
      jobs: [
        {
          providerJobId: 'job_2',
          stage: 'character_graph_bootstrap',
          planItemId: 'bundle_1',
          job: {
            id: 'job_2',
            status: 'cancelled',
            progress: {
              sourceContext: {
                bundleId: 'bundle_1',
              },
            },
          },
        },
      ],
    });

    expect(items).toEqual([
      expect.objectContaining({
        kind: 'cancelled_job',
        severity: 'warning',
        providerJobId: 'job_2',
        recommendedAction: 'resume_after_fix',
      }),
    ]);
  });

  it('labels a failed repair child as an exact same-request retry', () => {
    const items = buildBookAIWorkflowReviewItems({
      id: 'workflow_1',
      status: 'needs_review',
      progress: {
        workflowReviewTargets: [
          {
            providerJobId: 'repair_job_1',
            repairMode: 'pinned_candidate_repair',
          },
        ],
      },
      jobs: [
        {
          providerJobId: 'repair_job_1',
          stage: 'chapter_label_repair',
          planItemId: 'repair:window_1:candidate_1',
          job: {
            id: 'repair_job_1',
            type: 'chapter_label_repair',
            status: 'failed',
            progress: { sourceContext: { chapterId: 'chapter_1', labelingWindowId: 'window_1' } },
          },
        },
      ],
    });

    expect(items).toEqual([
      expect.objectContaining({
        providerJobId: 'repair_job_1',
        recommendedAction: 'retry_same_request',
        actionLabel: '동일 repair 요청 재시도',
        repairMode: 'pinned_candidate_repair',
      }),
    ]);
  });
});
