import { describe, expect, it } from 'vitest';
import { anchorFromReadingPosition, blockFromLegacyParagraph } from '../repositories/reader-document-repository';

describe('reader document compatibility helpers', () => {
  it('projects a paragraph-backed reading position into a format-neutral anchor', () => {
    expect(
      anchorFromReadingPosition(
        {
          id: 'position-1',
          novelId: 'book-1',
          chapterId: 'chapter-2',
          paragraphId: 'paragraph-7',
          paragraphIndex: 7,
          offsetInParagraph: 13.8,
          chapterProgress: 0.4,
          scrollTop: 120,
          deviceId: 'device-1',
          updatedAt: '2026-07-13T00:00:00.000Z',
        },
        'content-3',
      ),
    ).toEqual({
      bookId: 'book-1',
      contentRevisionId: 'content-3',
      sectionId: 'chapter-2',
      blockId: 'paragraph-7',
      offset: 13,
    });
  });

  it('does not invent an anchor when a legacy position has no paragraph identity', () => {
    expect(
      anchorFromReadingPosition(
        {
          id: 'position-1',
          novelId: 'book-1',
          chapterId: 'chapter-1',
          paragraphIndex: 0,
          offsetInParagraph: 0,
          chapterProgress: 0,
          scrollTop: 0,
          deviceId: 'device-1',
          updatedAt: '2026-07-13T00:00:00.000Z',
        },
        'content-1',
      ),
    ).toBeUndefined();
  });

  it('adapts a legacy paragraph without changing its text or source offsets', () => {
    expect(
      blockFromLegacyParagraph({
        bookId: 'book-1',
        chapterId: 'chapter-1',
        paragraphId: 'paragraph-1',
        paragraphIndex: 1,
        text: '보존해야 하는 본문',
        sourceStart: 20,
        sourceEnd: 30,
      }),
    ).toMatchObject({
      id: 'paragraph-1',
      sectionId: 'chapter-1',
      kind: 'paragraph',
      plainText: '보존해야 하는 본문',
      sourceStart: 20,
      sourceEnd: 30,
    });
  });
});
