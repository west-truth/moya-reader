import { describe, expect, it } from 'vitest';
import type { Paragraph, ReaderAnchor, ReaderPageBoundary } from '../../domain/types';
import {
  fragmentText,
  LruMap,
  pageIndexForAnchor,
  safeOversizedSentenceEnd,
  sentenceEnds,
  sliceParagraphForPage,
} from './reader-pagination-model';

const paragraph = {
  id: 'paragraph-1',
  novelId: 'book-1',
  chapterId: 'chapter-1',
  index: 1,
  text: '나는 A랑 싸웠다. 그래서 슬펐다.',
  startOffsetInChapter: 0,
  endOffsetInChapter: 21,
  textHash: 'hash',
} as Paragraph;

function anchor(offset: number): ReaderAnchor {
  return {
    bookId: 'book-1',
    contentRevisionId: 'revision-1',
    sectionId: 'chapter-1',
    blockId: paragraph.id,
    blockIndex: 0,
    offset,
  };
}

describe('reader sentence pagination model', () => {
  it('offers sentence ends and reconstructs exact source fragments', () => {
    const ends = sentenceEnds(paragraph.text, 0);
    expect(ends).toHaveLength(2);
    const first = { paragraph, paragraphIndex: 0, startOffset: 0, endOffset: ends[0] };
    const second = { paragraph, paragraphIndex: 0, startOffset: ends[0], endOffset: ends[1] };
    expect(fragmentText(first) + fragmentText(second)).toBe(paragraph.text);
    expect(fragmentText(first)).toContain('나는 A랑 싸웠다.');
    expect(fragmentText(second)).toContain('그래서 슬펐다.');
  });

  it('prefers whitespace and never splits a surrogate pair for an oversized sentence', () => {
    expect(safeOversizedSentenceEnd('아주 긴 문장입니다', 0, 5)).toBe(5);
    expect(safeOversizedSentenceEnd('가😀나다', 0, 2)).toBe(1);
  });

  it('clips EPUB inline marks and ruby semantics to the source fragment offsets', () => {
    const epubParagraph: Paragraph = {
      ...paragraph,
      text: '앞문장 한자 뒷문장',
      inlineMarks: [{ start: 4, end: 9, kind: 'strong' }],
      inlineSemantics: [{ start: 4, end: 6, kind: 'ruby', value: 'かんじ' }],
    };
    const sliced = sliceParagraphForPage(epubParagraph, 4, 9);
    expect(sliced.text).toBe('한자 뒷문');
    expect(sliced.inlineMarks).toEqual([{ start: 0, end: 5, kind: 'strong' }]);
    expect(sliced.inlineSemantics).toEqual([{ start: 0, end: 2, kind: 'ruby', value: 'かんじ' }]);
  });

  it('finds a page by anchor with a binary boundary lookup', () => {
    const boundaries: ReaderPageBoundary[] = [
      { index: 0, start: anchor(0), end: anchor(10) },
      { index: 1, start: anchor(10), end: anchor(paragraph.text.length) },
    ];
    expect(pageIndexForAnchor(boundaries, anchor(2))).toBe(0);
    expect(pageIndexForAnchor(boundaries, anchor(10))).toBe(1);
  });

  it('touches entries on read and evicts only the least recently used value', () => {
    const cache = new LruMap<number, string>(2);
    cache.set(1, 'one');
    cache.set(2, 'two');
    expect(cache.get(1)).toBe('one');
    cache.set(3, 'three');
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(1)).toBe('one');
  });
});
