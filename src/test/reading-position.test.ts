import { describe, expect, it } from 'vitest';
import type { Chapter, Paragraph } from '../domain/types';
import { resolveRestoreReadingPositionTarget } from '../reader/reading-position';
import type { ReadingPosition } from '../sync/types';

function chapter(overrides: Partial<Chapter> = {}): Chapter {
  return {
    id: 'chapter_1',
    novelId: 'novel_1',
    index: 1,
    title: '1화',
    normalizedText: '',
    textHash: 'hash',
    rawStartOffset: 0,
    rawEndOffset: 100,
    characterCount: 100,
    paragraphCount: 10,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

function position(overrides: Partial<ReadingPosition> = {}): ReadingPosition {
  return {
    id: 'reading_position_novel_1',
    novelId: 'novel_1',
    chapterId: 'chapter_1',
    paragraphId: 'paragraph_7',
    paragraphIndex: 7,
    offsetInParagraph: 0,
    chapterProgress: 0.7,
    scrollTop: 9876,
    deviceId: 'device_local',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

function paragraph(overrides: Partial<Paragraph> = {}): Paragraph {
  return {
    id: 'paragraph_4',
    novelId: 'novel_1',
    chapterId: 'chapter_1',
    index: 4,
    text: '본문',
    startOffsetInChapter: 0,
    endOffsetInChapter: 2,
    textHash: 'paragraph_hash',
    ...overrides,
  };
}

describe('reading position restore target', () => {
  it('uses paragraph index before stale scrollTop so layout changes do not break resume', () => {
    expect(resolveRestoreReadingPositionTarget(chapter(), position())).toMatchObject({
      canRestore: true,
      paragraphIndex: 6,
      paragraphId: 'paragraph_7',
      scrollTop: 9876,
    });
  });

  it('clamps paragraph index to the current chapter paragraph count', () => {
    expect(
      resolveRestoreReadingPositionTarget(chapter({ paragraphCount: 3 }), position({ paragraphIndex: 99 })),
    ).toMatchObject({
      canRestore: true,
      paragraphIndex: 2,
    });
  });

  it('falls back to resolved paragraph id when older positions lack paragraph index', () => {
    expect(
      resolveRestoreReadingPositionTarget(
        chapter(),
        position({ paragraphIndex: 0, paragraphId: 'paragraph_4' }),
        paragraph(),
      ),
    ).toMatchObject({
      canRestore: true,
      paragraphIndex: 3,
      paragraphId: 'paragraph_4',
    });
  });

  it('falls back to sanitized scrollTop when no paragraph target is available', () => {
    expect(
      resolveRestoreReadingPositionTarget(
        chapter(),
        position({ paragraphIndex: 0, paragraphId: undefined, scrollTop: -42 }),
      ),
    ).toEqual({
      canRestore: true,
      paragraphId: undefined,
      scrollTop: 0,
    });
  });

  it('rejects positions for another chapter', () => {
    expect(resolveRestoreReadingPositionTarget(chapter(), position({ chapterId: 'chapter_2' }))).toEqual({
      canRestore: false,
      scrollTop: 0,
    });
  });
});
