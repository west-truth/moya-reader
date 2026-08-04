import { describe, expect, it } from 'vitest';
import type { Chapter, Paragraph } from '../domain/types';
import {
  chapterLabelingResponseToResult,
  type ChapterLabelingLLMResponse,
} from '../providers/chapter-labeling-contract';

const chapter: Chapter = {
  id: 'chapter_1',
  novelId: 'book_1',
  index: 0,
  title: 'Chapter 1',
  normalizedText: 'Hello',
  textHash: 'chapter_hash',
  rawStartOffset: 0,
  rawEndOffset: 5,
  characterCount: 5,
  paragraphCount: 1,
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
};

const paragraph: Paragraph = {
  id: 'paragraph_1',
  novelId: 'book_1',
  chapterId: 'chapter_1',
  index: 0,
  text: 'Hello',
  startOffsetInChapter: 0,
  endOffsetInChapter: 5,
  textHash: 'paragraph_hash',
};

function response(segments: ChapterLabelingLLMResponse['segments']): ChapterLabelingLLMResponse {
  return { chapter_id: chapter.id, analysis_version: 1, segments };
}

function llmSegment(overrides: Partial<ChapterLabelingLLMResponse['segments'][number]> = {}) {
  return {
    paragraph_id: paragraph.id,
    start_offset: 0,
    end_offset: paragraph.text.length,
    type: 'narration' as const,
    speaker_id: 'narrator',
    candidate_speakers: [],
    listener_ids: [],
    emotion: 'neutral',
    confidence: 1,
    evidence: 'source',
    ...overrides,
  };
}

describe('chapter labeling response conversion', () => {
  it.each([5, 9])('rejects start_offset %s instead of silently dropping the segment', (startOffset) => {
    expect(() =>
      chapterLabelingResponseToResult(
        { novelId: 'book_1', chapter, paragraphs: [paragraph] },
        response([llmSegment({ start_offset: startOffset, end_offset: startOffset + 1 })]),
      ),
    ).toThrow('segment offsets out of range');
  });

  it('rejects duplicate provider segment ids', () => {
    expect(() =>
      chapterLabelingResponseToResult(
        { novelId: 'book_1', chapter, paragraphs: [paragraph] },
        response([
          llmSegment({ segment_id: 'duplicate', start_offset: 0, end_offset: 2 }),
          llmSegment({ segment_id: 'duplicate', start_offset: 2, end_offset: 5 }),
        ]),
      ),
    ).toThrow('duplicate segment_id');
  });

  it('rejects duplicate source anchors', () => {
    expect(() =>
      chapterLabelingResponseToResult(
        { novelId: 'book_1', chapter, paragraphs: [paragraph] },
        response([llmSegment(), llmSegment()]),
      ),
    ).toThrow('duplicate segment anchor');
  });
});
