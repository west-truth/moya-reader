import { describe, expect, it } from 'vitest';
import type { TTSReadinessReport, WorkflowProviderJobLinkRow } from './workflow-contracts.js';
import {
  dedupeLinksByProviderJobId,
  hasUnresolvedManualReview,
  labelingWindowIdsForMissingParagraphs,
  linkHasUnresolvedManualReview,
  pendingLinks,
  providerJobIsTerminal,
  reviewTargetForFailedLink,
  reviewTargetsForTTSReadiness,
  sortedStageLinks,
  succeededLinks,
  terminalFailure,
} from './workflow-state.js';
import { workflowPlan } from './book-ai-workflow-test-harness.js';

function link(input: {
  readonly providerJobId: string;
  readonly sequence: number;
  readonly status: WorkflowProviderJobLinkRow['status'];
  readonly stage?: string;
}): WorkflowProviderJobLinkRow {
  return {
    id: `link_${input.providerJobId}`,
    workflow_id: 'workflow_1',
    provider_job_id: input.providerJobId,
    stage: input.stage ?? 'chapter_labeling',
    plan_item_id: `window_${input.sequence}`,
    sequence: input.sequence,
    job_type: 'chapter_segment_labeling',
    provider_id: 'mock',
    model_id: 'model',
    input_hash: `hash_${input.providerJobId}`,
    status: input.status,
    progress: {},
    error_code: null,
    error_message: null,
  };
}

function readiness(overrides: Partial<TTSReadinessReport> = {}): TTSReadinessReport {
  return {
    ok: false,
    errorCode: 'tts_readiness_failed',
    message: 'Readiness failed.',
    metrics: {
      plannedChapterCount: 2,
      segmentCount: 4,
      labeledChapterCount: 2,
      plannedParagraphCount: 2,
      labeledPlannedParagraphCount: 2,
      missingPlannedParagraphCount: 0,
      unknownSegmentCount: 0,
      lowConfidenceSegmentCount: 0,
      characterSpeakerCount: 1,
      unknownSegmentRatio: 0,
      missingCharacterVoiceProfileCount: 0,
      narratorProfileCount: 1,
      systemProfileCount: 0,
      unknownProfileCount: 0,
    },
    missingCharacterVoiceSpeakerIds: [],
    missingPlannedParagraphIds: [],
    checkedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('book AI workflow transition policy', () => {
  it('classifies and orders child jobs without mutating the source list', () => {
    const links = [
      link({ providerJobId: 'job_b', sequence: 2, status: 'running' }),
      link({ providerJobId: 'job_c', sequence: 2, status: 'succeeded' }),
      link({ providerJobId: 'job_a', sequence: 1, status: 'failed' }),
    ];

    expect(sortedStageLinks(links).map((item) => item.provider_job_id)).toEqual(['job_a', 'job_b', 'job_c']);
    expect(links.map((item) => item.provider_job_id)).toEqual(['job_b', 'job_c', 'job_a']);
    expect(pendingLinks(links).map((item) => item.provider_job_id)).toEqual(['job_b']);
    expect(succeededLinks(links).map((item) => item.provider_job_id)).toEqual(['job_c']);
    expect(terminalFailure(links)?.provider_job_id).toBe('job_a');
    expect(providerJobIsTerminal({ status: 'cancelled' })).toBe(true);
    expect(providerJobIsTerminal({ status: 'running' })).toBe(false);
  });

  it('targets only labeling windows that contain missing planned paragraphs', () => {
    const targets = labelingWindowIdsForMissingParagraphs(
      { ttsReadiness: { missingPlannedParagraphIds: ['p2', 'not_planned'] } },
      workflowPlan(),
    );

    expect([...targets]).toEqual(['window_2']);
  });

  it('treats a promoted manual review as effective success while ignoring superseded repair failures', () => {
    const reviewed = link({ providerJobId: 'label_failed', sequence: 0, status: 'failed' });
    reviewed.progress = { manualReview: { status: 'promoted', reviewArtifactId: 'review_1' } };
    const supersededRepair = link({
      providerJobId: 'repair_failed',
      sequence: 0,
      status: 'failed',
      stage: 'chapter_label_repair',
    });
    supersededRepair.progress = { manualReview: { status: 'superseded', reviewArtifactId: 'review_1' } };

    expect(succeededLinks([reviewed, supersededRepair])).toEqual([reviewed]);
    expect(terminalFailure([reviewed, supersededRepair])).toBeUndefined();
  });

  it('does not complete operationally terminal jobs until manual review is resolved', () => {
    const ordinary = link({ providerJobId: 'ordinary', sequence: 0, status: 'succeeded' });
    const open = link({ providerJobId: 'open', sequence: 1, status: 'succeeded' });
    open.progress = { manualReview: { status: 'open', reviewArtifactId: 'review_open' } };
    const pending = link({ providerJobId: 'pending', sequence: 2, status: 'succeeded' });
    pending.progress = { manualReview: { status: 'pending', reviewArtifactId: 'review_pending' } };
    const rejected = link({ providerJobId: 'rejected', sequence: 3, status: 'failed' });
    rejected.progress = { manualReview: { status: 'rejected', reviewArtifactId: 'review_rejected' } };
    const approved = link({ providerJobId: 'approved', sequence: 4, status: 'failed' });
    approved.progress = { manualReview: { status: 'approved', reviewArtifactId: 'review_approved' } };
    const promoted = link({ providerJobId: 'promoted', sequence: 5, status: 'failed' });
    promoted.progress = { manualReview: { status: 'promoted', reviewArtifactId: 'review_promoted' } };

    expect(linkHasUnresolvedManualReview(open)).toBe(true);
    expect(linkHasUnresolvedManualReview(ordinary)).toBe(false);
    expect(hasUnresolvedManualReview([ordinary, open, pending, rejected])).toBe(true);
    expect(linkHasUnresolvedManualReview(approved)).toBe(true);
    expect(hasUnresolvedManualReview([ordinary, promoted])).toBe(false);
    expect(succeededLinks([ordinary, open, pending, rejected, approved, promoted])).toEqual([ordinary, promoted]);
    expect(terminalFailure([approved, promoted, rejected])).toBe(approved);
  });

  it('builds actionable readiness review targets from persisted readiness evidence', () => {
    const report = readiness({
      missingPlannedParagraphIds: ['p1'],
      missingCharacterVoiceSpeakerIds: ['character_1'],
      metrics: {
        ...readiness().metrics,
        missingPlannedParagraphCount: 1,
        missingCharacterVoiceProfileCount: 1,
        unknownSegmentRatio: 0.5,
      },
    });

    expect(reviewTargetsForTTSReadiness(workflowPlan(), report)).toEqual([
      expect.objectContaining({
        kind: 'missing_paragraph_labels',
        labelingWindowIds: ['window_1'],
        recommendedAction: 'retry_labeling_windows',
      }),
      expect.objectContaining({
        kind: 'missing_voice_profiles',
        speakerIds: ['character_1'],
        recommendedAction: 'assign_voice_profiles',
      }),
      expect.objectContaining({
        kind: 'high_unknown_speaker_ratio',
        recommendedAction: 'review_labels',
      }),
    ]);
  });

  it('deduplicates retry jobs and reports failed labeling context without mutating provider options', () => {
    const labeling = link({ providerJobId: 'job_1', sequence: 1, status: 'failed' });
    const graph = link({
      providerJobId: 'job_2',
      sequence: 0,
      status: 'cancelled',
      stage: 'character_graph_merge',
    });
    labeling.progress = {
      sourceContext: {
        chapterId: 'chapter_1',
        paragraphIds: ['p1'],
      },
    };

    expect(dedupeLinksByProviderJobId([labeling, graph, labeling])).toEqual([labeling, graph]);
    expect(reviewTargetForFailedLink(labeling)).toEqual(
      expect.objectContaining({
        chapterId: 'chapter_1',
        paragraphIds: ['p1'],
        recommendedAction: 'inspect_failed_job',
      }),
    );
  });
});
