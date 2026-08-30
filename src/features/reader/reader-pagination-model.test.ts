import { describe, expect, it } from 'vitest';
import type { Paragraph, ReaderAnchor, ReaderPageBoundary } from '../../domain/types';
import {
  bestFittingTextEnd,
  fragmentText,
  LruMap,
  pageIndexForAnchor,
  rebasePageBoundariesAtAnchor,
  safeOversizedSentenceEnd,
  sentenceEnds,
  sliceParagraphForPage,
  spliceForwardPageBoundaries,
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

  it('fills remaining page lines when the next complete sentence is too tall', () => {
    const text = '첫 문장은 이미 앞 블록 뒤에 이어집니다. 다음 문장도 페이지의 남은 줄을 활용해야 합니다.';
    const end = bestFittingTextEnd(text, 0, (candidate) => candidate <= 18);
    expect(end).toBeGreaterThan(0);
    expect(end).toBeLessThan(text.indexOf('.') + 1);
    expect(text.slice(0, end) + text.slice(end)).toBe(text);
    expect(/\s$/u.test(text.slice(0, end))).toBe(true);
  });

  it('continues past one complete sentence when part of the next sentence fits', () => {
    const text = '짧은 문장입니다. 다음 문장은 꽤 길어서 전부 들어가지는 않지만 남은 줄만큼 이어져야 합니다.';
    const firstSentenceEnd = text.indexOf('.') + 1;
    const end = bestFittingTextEnd(text, 0, (candidate) => candidate <= firstSentenceEnd + 18);
    expect(end).toBeGreaterThan(firstSentenceEnd);
    expect(end).toBeLessThan(text.length);
    expect(text.slice(0, end) + text.slice(end)).toBe(text);
  });

  it('keeps paragraph newline content lossless while choosing a usable break', () => {
    const text = '첫 줄입니다.\n두 번째 줄은 한 문장 안에서도 페이지를 채워야 합니다.';
    const end = bestFittingTextEnd(text, 0, (candidate) => candidate <= 18);
    expect(text.slice(0, end) + text.slice(end)).toBe(text);
    expect(end).toBeGreaterThan(text.indexOf('\n'));
  });

  it('uses additional responsive page height without changing source order', () => {
    const text = '긴 문장이 화면 높이에 맞춰 더 많은 단어를 자연스럽게 담아야 합니다. 다음 문장도 있습니다.';
    const compactEnd = bestFittingTextEnd(text, 0, (candidate) => candidate <= 18);
    const tallEnd = bestFittingTextEnd(text, 0, (candidate) => candidate <= 42);
    expect(tallEnd).toBeGreaterThan(compactEnd);
    expect(text.slice(0, compactEnd) + text.slice(compactEnd)).toBe(text);
    expect(text.slice(0, tallEnd) + text.slice(tallEnd)).toBe(text);
  });

  it('asks the caller for a new page when no source character fits', () => {
    expect(bestFittingTextEnd('다음 문장', 0, () => false)).toBe(0);
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

  it('starts a transition page at the next unread sentence without losing the prefix', () => {
    const boundaries: ReaderPageBoundary[] = [
      { index: 0, start: anchor(0), end: anchor(10) },
      { index: 1, start: anchor(10), end: anchor(paragraph.text.length) },
    ];
    const rebased = rebasePageBoundariesAtAnchor(boundaries, anchor(15));
    expect(rebased.applied).toBe(true);
    expect(rebased.pageIndex).toBe(2);
    expect(rebased.boundaries.map((item) => [item.start.offset, item.end.offset])).toEqual([
      [0, 10],
      [10, 15],
      [15, paragraph.text.length],
    ]);
    expect(rebased.boundaries[1].end).toEqual(rebased.boundaries[2].start);
  });

  it('fills forward from a transition anchor while retaining a lossless canonical bridge', () => {
    const canonical: ReaderPageBoundary[] = [
      { index: 0, start: anchor(0), end: anchor(10) },
      { index: 1, start: anchor(10), end: anchor(20) },
      { index: 2, start: anchor(20), end: anchor(30) },
    ];
    const forward: ReaderPageBoundary[] = [{ index: 0, start: anchor(8), end: anchor(18) }];
    const combined = spliceForwardPageBoundaries(canonical, anchor(8), forward);
    expect(combined.map((item) => [item.start.offset, item.end.offset])).toEqual([
      [0, 8],
      [8, 18],
      [18, 20],
      [20, 30],
    ]);
    expect(combined.slice(1).every((item, index) => item.start.offset === combined[index].end.offset)).toBe(true);
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
