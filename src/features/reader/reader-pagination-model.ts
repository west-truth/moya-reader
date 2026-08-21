import { sentenceRanges, type TextRange } from '@noveldesk/text-core/sentence-boundaries';
import type { Paragraph, ReaderAnchor, ReaderPageBoundary } from '../../domain/types';

export interface ReaderPageFragment {
  readonly paragraph: Paragraph;
  readonly paragraphIndex: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

export function sentenceEnds(text: string, startOffset: number): number[] {
  const ends = sentenceRanges(text)
    .filter((range) => range.end > startOffset)
    .map((range) => range.end);
  if (text.length > startOffset && ends.at(-1) !== text.length) ends.push(text.length);
  return [...new Set(ends)].sort((left, right) => left - right);
}

export function safeOversizedSentenceEnd(text: string, startOffset: number, measuredEnd: number): number {
  const bounded = Math.max(startOffset + 1, Math.min(text.length, measuredEnd));
  for (let index = bounded; index > startOffset + 1; index -= 1) {
    if (/\s/u.test(text[index - 1])) return index;
  }
  const previous = text.charCodeAt(bounded - 1);
  const current = text.charCodeAt(bounded);
  if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) return bounded - 1;
  return bounded;
}

function compareAnchor(left: ReaderAnchor, right: ReaderAnchor): number {
  const block = (left.blockIndex ?? 0) - (right.blockIndex ?? 0);
  return block || left.offset - right.offset;
}

export function pageIndexForAnchor(boundaries: readonly ReaderPageBoundary[], anchor: ReaderAnchor): number {
  let low = 0;
  let high = boundaries.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const boundary = boundaries[middle];
    if (compareAnchor(anchor, boundary.start) < 0) high = middle - 1;
    else if (compareAnchor(anchor, boundary.end) >= 0 && middle < boundaries.length - 1) low = middle + 1;
    else return middle;
  }
  return Math.max(0, Math.min(boundaries.length - 1, low));
}

export function fragmentText(fragment: Pick<ReaderPageFragment, 'paragraph' | 'startOffset' | 'endOffset'>): string {
  return fragment.paragraph.text.slice(fragment.startOffset, fragment.endOffset);
}

export function sliceParagraphForPage(paragraph: Paragraph, start: number, end: number): Paragraph {
  if (start === 0 && end >= paragraph.text.length) return paragraph;
  return {
    ...paragraph,
    text: paragraph.text.slice(start, end),
    inlineMarks: paragraph.inlineMarks
      ?.map((mark) => ({
        ...mark,
        start: Math.max(0, mark.start - start),
        end: Math.min(end - start, mark.end - start),
      }))
      .filter((mark) => mark.end > mark.start),
    inlineSemantics: paragraph.inlineSemantics
      ?.map((semantic) => ({
        ...semantic,
        start: Math.max(0, semantic.start - start),
        end: Math.min(end - start, semantic.end - start),
      }))
      .filter((semantic) => semantic.end > semantic.start),
  };
}

export class LruMap<K, V> {
  private readonly values = new Map<K, V>();

  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.limit) {
      const oldest = this.values.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  clear(): void {
    this.values.clear();
  }
}

export type { TextRange };
