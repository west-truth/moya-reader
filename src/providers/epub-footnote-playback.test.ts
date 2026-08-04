import { describe, expect, it } from 'vitest';
import type { Paragraph } from '../domain/types';
import { planEpubFootnotePlayback } from './epub-footnote-playback';

function paragraph(id: string, index: number, patch: Partial<Paragraph> = {}): Paragraph {
  return {
    id,
    novelId: 'book-1',
    chapterId: 'chapter-1',
    index,
    text: id,
    startOffsetInChapter: index * 10,
    endOffsetInChapter: index * 10 + id.length,
    textHash: `hash-${id}`,
    ...patch,
  };
}

const rows = [
  paragraph('body-1', 0, {
    inlineSemantics: [{ start: 3, end: 4, kind: 'footnote_reference', relatedBlockId: 'chapter.xhtml#note-1' }],
  }),
  paragraph('body-2', 1),
  paragraph('note-1', 2, {
    documentPageType: 'footnote',
    sourceHref: 'chapter.xhtml#note-1',
  }),
  paragraph('note-2', 3, {
    documentPageType: 'endnote',
    sourceHref: 'chapter.xhtml#note-2',
  }),
];

describe('EPUB footnote playback planner', () => {
  it('supports skip, immediate and chapter-end ordering without mutating source paragraphs', () => {
    expect(
      planEpubFootnotePlayback({ paragraphs: rows, startIndex: 0, policy: 'skip' }).paragraphs.map((row) => row.id),
    ).toEqual(['body-1', 'body-2']);
    expect(
      planEpubFootnotePlayback({ paragraphs: rows, startIndex: 0, policy: 'immediate' }).paragraphs.map(
        (row) => row.id,
      ),
    ).toEqual(['body-1', 'note-1', 'body-2', 'note-2']);
    expect(
      planEpubFootnotePlayback({ paragraphs: rows, startIndex: 0, policy: 'end_of_chapter' }).paragraphs.map(
        (row) => row.id,
      ),
    ).toEqual(['body-1', 'body-2', 'note-1', 'note-2']);
    expect(rows.map((row) => row.id)).toEqual(['body-1', 'body-2', 'note-1', 'note-2']);
  });

  it('includes a referenced earlier note when listening starts at its reference', () => {
    const reordered = [rows[2], rows[0], rows[1], rows[3]];
    expect(
      planEpubFootnotePlayback({ paragraphs: reordered, startIndex: 1, policy: 'immediate' }).paragraphs.map(
        (row) => row.id,
      ),
    ).toEqual(['body-1', 'note-1', 'body-2', 'note-2']);
  });
});
