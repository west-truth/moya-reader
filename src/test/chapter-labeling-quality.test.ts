import { describe, expect, it } from 'vitest';
import type { Chapter, LabeledSegment, Paragraph } from '../domain/types';
import { hashSync } from '../domain/hash';
import {
  chapterLabelingQualityErrorMessage,
  validateChapterLabelingQuality,
} from '../providers/chapter-labeling-quality';
import type { ChapterLabelingResult } from '../providers/ai';

function makeParagraph(index: number, text: string): Paragraph {
  return {
    id: `paragraph_${index}`,
    novelId: 'book_1',
    chapterId: 'chapter_1',
    index,
    text,
    startOffsetInChapter: index * 100,
    endOffsetInChapter: index * 100 + text.length,
    textHash: hashSync(text),
  };
}

function makeChapter(paragraphs: Paragraph[]): Chapter {
  const characterCount = paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
  return {
    id: 'chapter_1',
    novelId: 'book_1',
    index: 1,
    title: 'Chapter 1',
    normalizedText: paragraphs.map((paragraph) => paragraph.text).join('\n\n'),
    textHash: 'chapter_hash',
    rawStartOffset: 0,
    rawEndOffset: characterCount,
    characterCount,
    paragraphCount: paragraphs.length,
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
  };
}

function makeSegment(paragraph: Paragraph, index: number, overrides: Partial<LabeledSegment> = {}): LabeledSegment {
  const startOffset = overrides.startOffset ?? 0;
  const endOffset = overrides.endOffset ?? paragraph.text.length;
  return {
    id: `segment_${index}`,
    novelId: paragraph.novelId,
    chapterId: paragraph.chapterId,
    paragraphId: paragraph.id,
    segmentIndex: index,
    startOffset,
    endOffset,
    segmentTextHash: hashSync(paragraph.text.slice(startOffset, endOffset)),
    type: 'quoted_dialogue',
    speakerId: 'char_1',
    candidateSpeakers: [],
    listenerIds: [],
    emotion: 'calm',
    confidence: 0.91,
    isUserCorrected: false,
    ...overrides,
  };
}

function validate(paragraphs: Paragraph[], result: ChapterLabelingResult) {
  return validateChapterLabelingQuality({
    chapter: makeChapter(paragraphs),
    paragraphs,
    result,
  });
}

describe('chapter labeling quality gate', () => {
  it('accepts dense dialogue coverage with varied emotions', () => {
    const paragraphs = Array.from({ length: 10 }, (_, index) => makeParagraph(index, `"Line ${index}?"`));
    const result: ChapterLabelingResult = {
      characters: [],
      segments: paragraphs.map((paragraph, index) =>
        makeSegment(paragraph, index, { emotion: index % 2 === 0 ? 'tense' : 'calm' }),
      ),
    };

    const report = validate(paragraphs, result);

    expect(report.ok).toBe(true);
    expect(report.summary.errorCount).toBe(0);
    expect(report.metrics.dialogueLikeCoverageRatio).toBe(1);
    expect(report.metrics.targetCoverageRatio).toBe(1);
  });

  it('rejects sparse valid-looking labels that skip most likely dialogue paragraphs', () => {
    const paragraphs = Array.from({ length: 30 }, (_, index) => makeParagraph(index, `"What happened ${index}?"`));
    const result: ChapterLabelingResult = {
      characters: [],
      segments: [makeSegment(paragraphs[0], 0), makeSegment(paragraphs[1], 1)],
    };

    const report = validate(paragraphs, result);

    expect(report.ok).toBe(false);
    expect(report.summary.issueCodes).toEqual(
      expect.arrayContaining(['dialogue_like_coverage_low', 'target_coverage_low']),
    );
    expect(chapterLabelingQualityErrorMessage(report)).toContain('Chapter labeling quality failed');
  });

  it('warns but does not fail when many dialogue labels use a single emotion', () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => makeParagraph(index, `"Line ${index}."`));
    const result: ChapterLabelingResult = {
      characters: [],
      segments: paragraphs.map((paragraph, index) => makeSegment(paragraph, index, { emotion: 'neutral' })),
    };

    const report = validate(paragraphs, result);

    expect(report.ok).toBe(true);
    expect(report.summary.issueCodes).toContain('emotion_diversity_low');
    expect(report.summary.warningCount).toBe(1);
  });

  it('rejects dense dialogue labels when most speakers remain unknown', () => {
    const paragraphs = Array.from({ length: 10 }, (_, index) => makeParagraph(index, `"Line ${index}?"`));
    const result: ChapterLabelingResult = {
      characters: [],
      segments: paragraphs.map((paragraph, index) =>
        makeSegment(paragraph, index, {
          speakerId: 'unknown',
          emotion: index % 2 === 0 ? 'tense' : 'calm',
        }),
      ),
    };

    const report = validate(paragraphs, result);

    expect(report.ok).toBe(false);
    expect(report.summary.issueCodes).toContain('unknown_speaker_ratio_high');
    expect(report.metrics.unknownDialogueSegmentRatio).toBe(1);
  });

  it('does not force dialogue coverage on narration-only chapters', () => {
    const paragraphs = Array.from({ length: 20 }, (_, index) =>
      makeParagraph(index, `Narration line ${index} describes the room.`),
    );
    const result: ChapterLabelingResult = {
      characters: [],
      segments: [makeSegment(paragraphs[0], 0, { type: 'narration', speakerId: 'narrator' })],
    };

    const report = validate(paragraphs, result);

    expect(report.summary.issueCodes).not.toContain('dialogue_like_coverage_low');
  });

  it('does not treat ordinary apostrophes as dialogue quotes', () => {
    const paragraphs = Array.from({ length: 20 }, (_, index) =>
      makeParagraph(index, `It wasn't going to be easy, and it didn't end there ${index}.`),
    );
    const result: ChapterLabelingResult = {
      characters: [],
      segments: [makeSegment(paragraphs[0], 0, { type: 'narration', speakerId: 'narrator' })],
    };

    const report = validate(paragraphs, result);

    expect(report.metrics.dialogueLikeParagraphCount).toBe(0);
    expect(report.summary.issueCodes).not.toContain('dialogue_like_coverage_low');
  });

  it('detects Korean and full-width dialogue punctuation without mojibake patterns', () => {
    const paragraphs = [
      makeParagraph(0, '「뭐라고？」'),
      makeParagraph(1, '말도 안 돼！'),
      makeParagraph(2, '잠깐만…'),
      makeParagraph(3, '그는 조용히 문을 닫았다.'),
    ];
    const result: ChapterLabelingResult = {
      characters: [],
      segments: [
        makeSegment(paragraphs[0], 0, { emotion: 'surprised' }),
        makeSegment(paragraphs[1], 1, { emotion: 'angry' }),
        makeSegment(paragraphs[2], 2, { emotion: 'tense' }),
      ],
    };

    const report = validateChapterLabelingQuality({
      chapter: makeChapter(paragraphs),
      paragraphs,
      result,
      minDialogueParagraphsForCoverage: 1,
    });

    expect(report.metrics.dialogueLikeParagraphCount).toBe(3);
    expect(report.metrics.labeledDialogueLikeParagraphCount).toBe(3);
    expect(report.summary.issueCodes).not.toContain('dialogue_like_coverage_low');
  });

  it('uses only target window text as the coverage denominator', () => {
    const paragraphs = [makeParagraph(0, 'A'.repeat(12_000))];
    const chapter = { ...makeChapter(paragraphs), characterCount: 120_000 };
    const result: ChapterLabelingResult = {
      characters: [],
      segments: [makeSegment(paragraphs[0], 0)],
    };

    const report = validateChapterLabelingQuality({ chapter, paragraphs, result });

    expect(report.metrics.targetNonWhitespaceCharacters).toBe(12_000);
    expect(report.metrics.coveredTargetNonWhitespaceCharacters).toBe(12_000);
    expect(report.metrics.targetCoverageRatio).toBe(1);
    expect(report.summary.issueCodes).not.toContain('target_coverage_low');
  });

  it('counts interval union coverage so overlaps cannot exceed one', () => {
    const paragraphs = [makeParagraph(0, 'abcdefghij')];
    const result: ChapterLabelingResult = {
      characters: [],
      segments: [
        makeSegment(paragraphs[0], 0, { startOffset: 0, endOffset: 8 }),
        makeSegment(paragraphs[0], 1, { startOffset: 2, endOffset: 10 }),
      ],
    };

    const report = validate(paragraphs, result);

    expect(report.metrics.coveredTargetNonWhitespaceCharacters).toBe(10);
    expect(report.metrics.targetCoverageRatio).toBe(1);
  });
});
