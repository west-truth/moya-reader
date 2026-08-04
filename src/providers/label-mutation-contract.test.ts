import type { LabeledSegment } from '../domain/types';
import { chapterSegmentsRevision, correctionsRevision } from '../domain/resource-revisions';
import { describe, expect, it } from 'vitest';
import {
  buildLabelMutationPlanV2,
  labelMutationCommandHash,
  labelMutationSegmentHash,
  LabelMutationConflictError,
  type ApplyLabelCorrectionsCommandV2,
} from './label-mutation-contract';

const segment: LabeledSegment = {
  id: 'segment_1',
  novelId: 'book_1',
  chapterId: 'chapter_1',
  paragraphId: 'paragraph_1',
  segmentIndex: 0,
  startOffset: 0,
  endOffset: 5,
  segmentTextHash: 'text_hash',
  type: 'quoted_dialogue',
  speakerId: 'unknown',
  candidateSpeakers: ['character_1'],
  listenerIds: [],
  emotion: 'neutral',
  confidence: 0.5,
  isUserCorrected: false,
};

function command(): ApplyLabelCorrectionsCommandV2 {
  return {
    operationId: 'operation_1',
    bookId: 'book_1',
    chapterId: 'chapter_1',
    createdAt: '2026-07-11T00:00:00.000Z',
    expected: {
      contentRevisionId: 'content_1',
      correctionRevisionId: correctionsRevision([]),
      segmentCollectionRevision: chapterSegmentsRevision([segment]),
    },
    edits: [
      {
        segmentId: segment.id,
        expectedSegmentHash: labelMutationSegmentHash(segment),
        patch: {
          speakerId: 'character_1',
          listenerIds: ['character_2'],
          emotion: 'tense',
          prosodyIntent: { pace: 'slow', intensity: 'high' },
        },
        intent: { kind: 'segment_only' },
      },
    ],
  };
}

describe('label mutation contract', () => {
  it('builds deterministic segment updates and field-level correction provenance', () => {
    const plan = buildLabelMutationPlanV2(command(), [segment]);

    expect(plan.commandHash).toBe(labelMutationCommandHash(command()));
    expect(plan.segments[0]).toMatchObject({
      speakerId: 'character_1',
      candidateSpeakers: ['character_1'],
      listenerIds: ['character_2'],
      emotion: 'tense',
      prosodyIntent: { pace: 'slow', intensity: 'high' },
      confidence: 1,
      isUserCorrected: true,
    });
    expect(plan.corrections.map((correction) => correction.correctionType)).toEqual([
      'speaker',
      'listener',
      'emotion',
      'prosody',
    ]);
    expect(plan.corrections.every((correction) => correction.applyScope === 'segment')).toBe(true);
    expect(plan.corrections.every((correction) => correction.operationId === 'operation_1')).toBe(true);
    expect(plan.staleTTSSegmentIds).toEqual(['segment_1']);
    expect(plan.requiresContextInvalidation).toBe(true);
  });

  it('creates a bounded reanalysis plan for broad intents', () => {
    const base = command();
    const plan = buildLabelMutationPlanV2(
      {
        ...base,
        edits: [
          {
            ...base.edits[0],
            patch: { speakerId: 'character_1' },
            intent: { kind: 'relabel_from_window', windowId: 'window_3' },
          },
        ],
      },
      [segment],
    );

    expect(plan.contextFromWindowId).toBe('window_3');
    expect(plan.relabelPlanId).toMatch(/^label_reanalysis_plan_/);
    expect(plan.corrections[0]).toMatchObject({ applyScope: 'future_pattern', intentKind: 'relabel_from_window' });
  });

  it('rejects stale segment hashes before producing writes', () => {
    const base = command();
    const stale = {
      ...base,
      edits: [{ ...base.edits[0], expectedSegmentHash: 'stale' }],
    };
    expect(() => buildLabelMutationPlanV2(stale, [segment])).toThrow(LabelMutationConflictError);
  });
});
