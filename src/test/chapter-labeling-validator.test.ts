import { describe, expect, it } from 'vitest';
import type { Chapter, Character, LabeledSegment, Paragraph } from '../domain/types';
import { hashSync } from '../domain/hash';
import {
  chapterLabelingValidationErrorMessage,
  validateChapterLabelingResult,
} from '../providers/chapter-labeling-validator';

const chapter: Chapter = {
  id: 'chapter_1',
  novelId: 'book_1',
  index: 0,
  title: 'Chapter 1',
  normalizedText: '',
  textHash: 'chapter_hash',
  rawStartOffset: 0,
  rawEndOffset: 22,
  characterCount: 22,
  paragraphCount: 1,
  createdAt: '2026-07-06T00:00:00.000Z',
  updatedAt: '2026-07-06T00:00:00.000Z',
};

const paragraph: Paragraph = {
  id: 'paragraph_1',
  novelId: 'book_1',
  chapterId: 'chapter_1',
  index: 0,
  text: 'Narration. "Hello."',
  startOffsetInChapter: 0,
  endOffsetInChapter: 19,
  textHash: 'paragraph_hash',
};

const character: Character = {
  id: 'char_1',
  novelId: 'book_1',
  canonicalName: 'Alex',
  aliases: ['Al'],
  color: '#3b82f6',
  confidence: 0.9,
  isUserConfirmed: true,
};

function segment(overrides: Partial<LabeledSegment>): LabeledSegment {
  const startOffset = overrides.startOffset ?? 0;
  const endOffset = overrides.endOffset ?? paragraph.text.length;
  return {
    id: 'segment_1',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    paragraphId: 'paragraph_1',
    segmentIndex: 0,
    startOffset,
    endOffset,
    segmentTextHash: hashSync(paragraph.text.slice(startOffset, endOffset)),
    type: 'narration',
    speakerId: 'narrator',
    candidateSpeakers: [],
    listenerIds: [],
    emotion: 'neutral',
    confidence: 0.99,
    isUserCorrected: false,
    ...overrides,
  };
}

function validate(
  segments: LabeledSegment[],
  knownCharacters: Character[] = [character],
  validationPolicy: 'legacy' | 'strict_tts' = 'legacy',
) {
  return validateChapterLabelingResult({
    novelId: 'book_1',
    chapter,
    paragraphs: [paragraph],
    knownCharacters,
    validationPolicy,
    result: {
      characters: [],
      segments,
    },
  });
}

function validateWithGraphOnlySpeaker(segments: LabeledSegment[]) {
  return validateChapterLabelingResult({
    novelId: 'book_1',
    chapter,
    paragraphs: [paragraph],
    characterGraph: {
      novelId: 'book_1',
      characters: [character],
      relations: [],
    },
    result: {
      characters: [],
      segments,
    },
  });
}

describe('chapter labeling validator', () => {
  it('accepts exact anchored labels that use reserved or known speakers', () => {
    const report = validate([
      segment({ id: 'segment_1', startOffset: 0, endOffset: 11, speakerId: 'narrator', type: 'narration' }),
      segment({
        id: 'segment_2',
        segmentIndex: 1,
        startOffset: 11,
        endOffset: paragraph.text.length,
        speakerId: 'char_1',
        type: 'quoted_dialogue',
      }),
    ]);

    expect(report.ok).toBe(true);
    expect(report.summary.errorCount).toBe(0);
  });

  it('rejects overlapping spans and unknown character ids before storage', () => {
    const report = validate([
      segment({ id: 'segment_1', startOffset: 0, endOffset: 12, speakerId: 'narrator' }),
      segment({
        id: 'segment_2',
        segmentIndex: 1,
        startOffset: 10,
        endOffset: paragraph.text.length,
        speakerId: 'char_missing',
      }),
    ]);

    expect(report.ok).toBe(false);
    expect(report.summary.issueCodes).toEqual(expect.arrayContaining(['overlapping_segments', 'unknown_speaker_id']));
    expect(chapterLabelingValidationErrorMessage(report)).toContain('Chapter labeling validation failed');
  });

  it('accepts speaker ids supplied by Character Graph context', () => {
    const report = validateWithGraphOnlySpeaker([segment({ speakerId: 'char_1', type: 'quoted_dialogue' })]);

    expect(report.ok).toBe(true);
    expect(report.summary.errorCount).toBe(0);
  });

  it('rejects stale text hashes for anchored segments', () => {
    const report = validate([segment({ segmentTextHash: 'stale_hash' })]);

    expect(report.ok).toBe(false);
    expect(report.summary.issueCodes).toContain('segment_text_hash_mismatch');
  });

  it('rejects non-whitespace gaps before narrator fallback can hide them', () => {
    const report = validate([segment({ startOffset: 11, endOffset: paragraph.text.length, speakerId: 'char_1' })]);

    expect(report.ok).toBe(false);
    expect(report.summary.issueCodes).toContain('unlabeled_gap');
    expect(report.summary.errorCount).toBeGreaterThan(0);
  });

  it('allows whitespace-only gaps while preserving exact source coverage', () => {
    const report = validate([
      segment({ id: 'segment_1', startOffset: 0, endOffset: 10, speakerId: 'narrator' }),
      segment({
        id: 'segment_2',
        segmentIndex: 1,
        startOffset: 11,
        endOffset: paragraph.text.length,
        speakerId: 'char_1',
      }),
    ]);

    expect(paragraph.text.slice(10, 11)).toBe(' ');
    expect(report.ok).toBe(true);
    expect(report.summary.issueCodes).not.toContain('unlabeled_gap');
  });

  it('rejects a missing target paragraph even when another paragraph is fully labeled', () => {
    const omitted: Paragraph = {
      ...paragraph,
      id: 'paragraph_2',
      index: 1,
      text: 'Omitted narration.',
      textHash: 'paragraph_2_hash',
    };
    const report = validateChapterLabelingResult({
      novelId: 'book_1',
      chapter,
      paragraphs: [paragraph, omitted],
      knownCharacters: [character],
      result: { characters: [], segments: [segment({})] },
    });

    expect(report.ok).toBe(false);
    expect(report.summary.issueCodes).toContain('missing_paragraph_result');
  });

  it('rejects unknown and duplicate candidate or listener ids', () => {
    const report = validate([
      segment({
        candidateSpeakers: ['char_missing', 'char_missing'],
        listenerIds: ['char_missing'],
      }),
    ]);

    expect(report.ok).toBe(false);
    expect(report.summary.issueCodes).toEqual(
      expect.arrayContaining(['unknown_candidate_id', 'duplicate_candidate_id', 'unknown_listener_id']),
    );
  });

  it('rejects duplicate identities, indexes, anchors, and source-order reversal', () => {
    const report = validate([
      segment({ id: 'duplicate', segmentIndex: 0, startOffset: 11, endOffset: paragraph.text.length }),
      segment({ id: 'duplicate', segmentIndex: 0, startOffset: 0, endOffset: 11 }),
      segment({ id: 'third', segmentIndex: 2, startOffset: 0, endOffset: 11 }),
    ]);

    expect(report.ok).toBe(false);
    expect(report.summary.issueCodes).toEqual(
      expect.arrayContaining([
        'duplicate_segment_id',
        'duplicate_segment_index',
        'duplicate_segment_anchor',
        'segments_out_of_source_order',
      ]),
    );
  });

  it('enforces the controlled emotion taxonomy only for strict TTS output', () => {
    expect(validate([segment({ emotion: 'worried' })]).ok).toBe(true);

    const strict = validate([segment({ emotion: 'worried' })], [character], 'strict_tts');
    expect(strict.ok).toBe(false);
    expect(strict.summary.issueCodes).toContain('invalid_emotion');
  });
});
