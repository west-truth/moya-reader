import { describe, expect, it } from 'vitest';
import type { ChapterLabelingResult } from './ai';
import { buildAnalysisReviewCorrectionPlanV2 } from './analysis-review-correction';

function candidate(): ChapterLabelingResult {
  return {
    characters: [],
    segments: [
      {
        id: 'segment_1',
        novelId: 'book_1',
        chapterId: 'chapter_1',
        paragraphId: 'paragraph_1',
        segmentIndex: 0,
        startOffset: 0,
        endOffset: 4,
        segmentTextHash: 'text_hash_1',
        type: 'quoted_dialogue',
        speakerId: 'unknown',
        candidateSpeakers: ['character_1'],
        listenerIds: [],
        emotion: 'neutral',
        confidence: 0.5,
        isUserCorrected: false,
      },
    ],
    segmentAnnotations: {
      segment_1: { evidenceCodes: [], prosodyIntent: { pace: 'normal' } },
    },
  };
}

describe('analysis review correction plan', () => {
  it('creates field provenance only for user edits and carries the selected scope', () => {
    const original = candidate();
    const approved = candidate();
    approved.segments[0] = {
      ...approved.segments[0],
      speakerId: 'character_1',
      candidateSpeakers: ['character_1'],
      emotion: 'sadness',
    };
    approved.segmentAnnotations = {
      segment_1: { evidenceCodes: [], prosodyIntent: { pace: 'slow', delivery: 'soft' } },
    };

    const plan = buildAnalysisReviewCorrectionPlanV2({
      operationId: 'operation_1',
      reviewArtifactId: 'review_1',
      bookId: 'book_1',
      chapterId: 'chapter_1',
      windowId: 'window_1',
      createdAt: '2026-07-11T00:00:00.000Z',
      original,
      approved,
      editIntents: { segment_1: { kind: 'relabel_from_window', windowId: 'window_1' } },
    });

    expect(plan.changedFieldsBySegment.segment_1).toEqual(['speakerId', 'emotion', 'prosodyIntent']);
    expect(plan.corrections.map((item) => item.correctionType)).toEqual(['speaker', 'emotion', 'prosody']);
    expect(plan.corrections.every((item) => item.applyScope === 'future_pattern')).toBe(true);
    expect(plan.corrections.every((item) => item.sourceReviewArtifactId === 'review_1')).toBe(true);
    expect(plan.segments[0]).toMatchObject({
      speakerId: 'character_1',
      emotion: 'sadness',
      prosodyIntent: { pace: 'slow', delivery: 'soft' },
      isUserCorrected: true,
    });
    expect(plan.contextFromWindowId).toBe('window_1');
    expect(plan.relabelPlanId).toBeTruthy();
    expect(plan.staleTTSSegmentIds).toEqual(['segment_1']);
  });

  it('keeps an unchanged generated approval free of user correction provenance', () => {
    const original = candidate();
    const plan = buildAnalysisReviewCorrectionPlanV2({
      operationId: 'operation_2',
      reviewArtifactId: 'review_2',
      bookId: 'book_1',
      chapterId: 'chapter_1',
      windowId: 'window_1',
      createdAt: '2026-07-11T00:00:00.000Z',
      original,
      approved: candidate(),
    });

    expect(plan.corrections).toEqual([]);
    expect(plan.changedFieldsBySegment).toEqual({});
    expect(plan.segments[0].isUserCorrected).toBe(false);
  });

  it('records a structural replacement as a segment type correction', () => {
    const approved = candidate();
    approved.segments[0] = {
      ...approved.segments[0],
      id: 'segment_replacement',
      endOffset: 8,
      segmentTextHash: 'replacement_hash',
      type: 'narration',
      speakerId: 'narrator',
    };

    const plan = buildAnalysisReviewCorrectionPlanV2({
      operationId: 'operation_3',
      reviewArtifactId: 'review_3',
      bookId: 'book_1',
      chapterId: 'chapter_1',
      windowId: 'window_1',
      createdAt: '2026-07-11T00:00:00.000Z',
      original: candidate(),
      approved,
    });

    expect(plan.corrections).toHaveLength(1);
    expect(plan.corrections[0]).toMatchObject({
      segmentId: 'segment_replacement',
      correctionType: 'segment_type',
      applyScope: 'segment',
    });
  });
});
