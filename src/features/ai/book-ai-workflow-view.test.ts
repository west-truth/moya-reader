import { describe, expect, it } from 'vitest';
import type { BookAnalysisWorkflow } from './book-analysis-workflow-gateway';
import { bookAIWorkflowCompactSpeakerView, bookAIWorkflowControlState } from './book-ai-workflow-view';

function workflow(status: string, outcome: BookAnalysisWorkflow['readiness']['outcome']): BookAnalysisWorkflow {
  return {
    id: 'workflow-1',
    novelId: 'novel-1',
    workflowType: 'full_book_analysis',
    workflowDefinitionId: 'moya.ai.tts.book-preparation',
    workflowVersion: '1.0.0',
    runtime: 'native',
    providerId: 'gemini',
    planHash: 'plan-hash',
    plan: {
      novelId: 'novel-1',
      totalChapters: 0,
      totalCharacters: 0,
      stages: [],
      bundleWindows: [],
      labelingWindows: [],
      labelingChapters: [],
      ttsReady: { chapterIds: [], dependsOnLabelingWindowIds: [] },
    },
    status,
    stage: 'tts_ready_preparation',
    readiness: {
      outcome,
      reviewItems:
        outcome === 'needs_review'
          ? [
              {
                id: 'review-1',
                kind: 'workflow_error',
                severity: 'error',
                title: 'Review',
                detail: 'Review the workflow output.',
                recommendedAction: 'retry_workflow',
                actionLabel: 'Retry',
              },
            ]
          : [],
    },
    jobs: [],
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}

describe('bookAIWorkflowControlState', () => {
  it('keeps a review workflow retryable but not cancellable or startable', () => {
    const state = bookAIWorkflowControlState({
      workflow: workflow('needs_review', 'needs_review'),
      available: true,
      hasNovel: true,
      loading: false,
      running: false,
      anotherAnalysisRunning: false,
      providerBlocked: false,
    });

    expect(state).toMatchObject({ needsReview: true, retryDisabled: false, cancelDisabled: true, startDisabled: true });
    expect(state.reviewItems).toHaveLength(1);
  });

  it('exposes explicit TTS readiness without inferring it from success alone', () => {
    const ready = bookAIWorkflowControlState({
      workflow: workflow('succeeded', 'ready_for_tts'),
      available: true,
      hasNovel: true,
      loading: false,
      running: false,
      anotherAnalysisRunning: false,
      providerBlocked: false,
    });
    const ambiguous = bookAIWorkflowControlState({
      workflow: workflow('succeeded', 'pending'),
      available: true,
      hasNovel: true,
      loading: false,
      running: false,
      anotherAnalysisRunning: false,
      providerBlocked: false,
    });

    expect(ready.labelVoiceReady).toBe(true);
    expect(ambiguous.labelVoiceReady).toBe(false);
  });
});

describe('bookAIWorkflowCompactSpeakerView', () => {
  it('returns no add-on detail for a legacy labeling workflow', () => {
    const base = workflow('running', 'pending');
    const legacy: BookAnalysisWorkflow = {
      ...base,
      jobs: [
        {
          id: 'link-1',
          workflowId: base.id,
          providerJobId: 'job-1',
          stage: 'chapter_labeling',
          planItemId: 'window-1',
          sequence: 1,
          job: {
            id: 'job-1',
            novelId: base.novelId,
            type: 'chapter_segment_labeling',
            providerId: 'gemini',
            inputHash: 'input-1',
            status: 'running',
            stage: 'labeling_chapter',
            progress: { budgetEstimate: { requestProfileId: 'chapter-labeling-v1' } },
            createdAt: base.createdAt,
            updatedAt: base.updatedAt,
          },
          createdAt: base.createdAt,
        },
      ],
    };

    expect(bookAIWorkflowCompactSpeakerView(legacy)).toBeUndefined();
  });

  it('projects only compact status, safe counts, escalation cap, and grouped risk classes', () => {
    const base = workflow('needs_review', 'needs_review');
    const compact: BookAnalysisWorkflow = {
      ...base,
      jobs: [
        {
          id: 'link-compact',
          workflowId: base.id,
          providerJobId: 'job-compact',
          stage: 'chapter_labeling',
          planItemId: 'window-compact',
          sequence: 2,
          job: {
            id: 'job-compact',
            novelId: base.novelId,
            type: 'speaker_attribution_v3',
            providerId: 'gemini',
            inputHash: 'input-compact',
            status: 'succeeded',
            stage: 'ready',
            progress: {
              sourceContext: { labelingContract: 'speaker-attribution-workflow-v3' },
              budgetEstimate: {
                requestProfileId: 'speaker-attribution-v3-compact',
                sceneRequestCount: 3,
                targetSpanCount: 18,
                escalationMaximumRatio: 0.15,
                escalationMaximumTargets: 4,
              },
              manualReview: { status: 'open', reviewArtifactId: 'review-1' },
              riskRoutes: [
                { riskClass: 'candidate', targetSpanIndexes: [1, 2], reasonCodes: ['candidate_missing'] },
                { riskClass: 'semantic', targetSpanIndexes: [4, 5], reasonCodes: ['semantic_ambiguity'] },
                { riskClass: 'semantic', targetSpanIndexes: [5, 6], reasonCodes: ['provider_raw_output'] },
              ],
              rawPrompt: 'must not be projected',
              providerOutput: { text: 'must not be projected' },
            },
            createdAt: base.createdAt,
            updatedAt: base.updatedAt,
          },
          createdAt: base.createdAt,
        },
      ],
    };

    expect(bookAIWorkflowCompactSpeakerView(compact)).toEqual({
      contractId: 'speaker-attribution-workflow-v3',
      requestProfileId: 'speaker-attribution-v3-compact',
      stage: 'review',
      stageLabel: '검토 항목 분류',
      targetSpanCount: 18,
      sceneRequestCount: 3,
      escalationCapLabel: '최대 15% / 4개',
      riskSummaries: [
        { riskClass: 'candidate', label: '화자 후보', targetSpanCount: 2 },
        { riskClass: 'semantic', label: '의미 모호성', targetSpanCount: 3 },
      ],
    });
  });

  it.each([
    ['pinning_speaker_source', 'source', '원문 고정'],
    ['building_speaker_inventory', 'inventory', '대화 구간 정리'],
    ['loading_speaker_snapshot', 'snapshot', '문맥 스냅샷 준비'],
    ['attributing_speakers', 'attribution', '화자 판별'],
    ['decoding_speaker_sequence', 'sequence', '대화 순서 판정'],
    ['escalating_speakers', 'escalation', '모호 구간 재판별'],
    ['routing_speaker_review', 'review', '검토 항목 분류'],
  ])('maps %s to a human-readable compact stage', (jobStage, expectedStage, expectedLabel) => {
    const base = workflow('running', 'pending');
    const compact: BookAnalysisWorkflow = {
      ...base,
      jobs: [
        {
          id: `link-${jobStage}`,
          workflowId: base.id,
          providerJobId: `job-${jobStage}`,
          stage: 'chapter_labeling',
          planItemId: 'window-1',
          sequence: 1,
          job: {
            id: `job-${jobStage}`,
            novelId: base.novelId,
            type: 'speaker_attribution_v3',
            providerId: 'gemini',
            inputHash: 'input-1',
            status: 'running',
            stage: jobStage,
            progress: { sourceContext: { labelingContract: 'speaker-attribution-workflow-v3' } },
            createdAt: base.createdAt,
            updatedAt: base.updatedAt,
          },
          createdAt: base.createdAt,
        },
      ],
    };

    expect(bookAIWorkflowCompactSpeakerView(compact)).toMatchObject({
      stage: expectedStage,
      stageLabel: expectedLabel,
    });
  });
});
