import { describe, expect, it } from 'vitest';
import type { LabeledSegment } from '../domain/types';
import {
  applyLabelCorrection,
  buildCorrectionEmotionOptions,
  buildLabelCorrectionReviewItems,
  groupSegmentsByParagraph,
  labelCorrectionReasons,
} from '../providers/label-correction-review';

function segment(overrides: Partial<LabeledSegment>): LabeledSegment {
  return {
    id: 'seg_1',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    paragraphId: 'paragraph_1',
    segmentIndex: 1,
    startOffset: 0,
    endOffset: 4,
    segmentTextHash: 'hash_1',
    type: 'quoted_dialogue',
    speakerId: 'char_1',
    candidateSpeakers: ['char_1'],
    listenerIds: [],
    emotion: 'neutral',
    confidence: 0.9,
    isUserCorrected: false,
    ...overrides,
  };
}

describe('label correction review helpers', () => {
  it('groups paragraph segments in source order', () => {
    const grouped = groupSegmentsByParagraph([
      segment({ id: 'seg_b', paragraphId: 'paragraph_1', segmentIndex: 2, startOffset: 10 }),
      segment({ id: 'seg_a', paragraphId: 'paragraph_1', segmentIndex: 1, startOffset: 0 }),
      segment({ id: 'seg_c', paragraphId: 'paragraph_2', segmentIndex: 3, startOffset: 0 }),
    ]);

    expect(grouped.get('paragraph_1')?.map((item) => item.id)).toEqual(['seg_a', 'seg_b']);
    expect(grouped.get('paragraph_2')?.map((item) => item.id)).toEqual(['seg_c']);
  });

  it('prioritizes unknown and low-confidence labels while skipping user-corrected segments', () => {
    const items = buildLabelCorrectionReviewItems({
      segments: [
        segment({ id: 'ok', segmentIndex: 3, confidence: 0.95 }),
        segment({ id: 'low', segmentIndex: 2, confidence: 0.4 }),
        segment({
          id: 'ambiguous',
          segmentIndex: 4,
          speakerId: 'char_1',
          confidence: 0.91,
          candidateSpeakers: ['char_1', 'char_2'],
        }),
        segment({
          id: 'unknown',
          segmentIndex: 1,
          speakerId: 'unknown',
          confidence: 0.8,
          candidateSpeakers: ['char_1', 'char_2'],
        }),
        segment({ id: 'fixed', segmentIndex: 0, speakerId: 'unknown', confidence: 0.2, isUserCorrected: true }),
      ],
    });

    expect(items.map((item) => item.segment.id)).toEqual(['unknown', 'low', 'ambiguous']);
    expect(items[0].reasons).toEqual(['unknown_speaker', 'multiple_candidates']);
    expect(items[1].reasons).toEqual(['low_confidence']);
    expect(items[2].reasons).toEqual(['multiple_candidates']);
  });

  it('applies speaker and emotion corrections without keeping stale voice bindings', () => {
    const original = segment({
      speakerId: 'char_old',
      candidateSpeakers: ['char_old', 'char_new'],
      emotion: 'sad',
      voiceProfileId: 'voice_old',
      confidence: 0.42,
    });
    const corrected = applyLabelCorrection({
      segment: original,
      speakerId: 'char_new',
      emotion: 'tense',
    });

    expect(corrected).toEqual(
      expect.objectContaining({
        speakerId: 'char_new',
        candidateSpeakers: ['char_new'],
        emotion: 'tense',
        confidence: 1,
        isUserCorrected: true,
        voiceProfileId: undefined,
      }),
    );
  });

  it('preserves the existing voice binding when only emotion changes', () => {
    const original = segment({
      speakerId: 'char_1',
      candidateSpeakers: ['char_1', 'char_2'],
      emotion: 'sad',
      voiceProfileId: 'voice_1',
      confidence: 0.5,
    });
    const corrected = applyLabelCorrection({
      segment: original,
      speakerId: 'char_1',
      emotion: 'warm',
    });

    expect(corrected).toEqual(
      expect.objectContaining({
        speakerId: 'char_1',
        candidateSpeakers: ['char_1', 'char_2'],
        emotion: 'warm',
        confidence: 0.5,
        voiceProfileId: 'voice_1',
        isUserCorrected: false,
      }),
    );
    expect(labelCorrectionReasons(corrected)).toEqual(['low_confidence', 'multiple_candidates']);
  });

  it('can confirm the current speaker while applying an emotion correction', () => {
    const corrected = applyLabelCorrection({
      segment: segment({
        speakerId: 'char_1',
        candidateSpeakers: ['char_1', 'char_2'],
        emotion: 'sad',
        voiceProfileId: 'voice_1',
        confidence: 0.5,
      }),
      speakerId: 'char_1',
      emotion: 'warm',
      confirmSpeaker: true,
    });

    expect(corrected).toEqual(
      expect.objectContaining({
        speakerId: 'char_1',
        candidateSpeakers: ['char_1'],
        emotion: 'warm',
        confidence: 1,
        voiceProfileId: 'voice_1',
        isUserCorrected: true,
      }),
    );
  });

  it('keeps custom current emotions selectable', () => {
    expect(buildCorrectionEmotionOptions('awkward', 'neutral')).toEqual([
      'neutral',
      'calm',
      'warm',
      'happy',
      'sad',
      'angry',
      'tense',
      'fearful',
      'surprised',
      'systematic',
      'awkward',
    ]);
  });
});
