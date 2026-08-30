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

/**
 * Finds the furthest source offset that fits in the remaining page space.
 *
 * The measured limit is preferred over sentence-atomic pagination because a
 * complete sentence followed by part of a long sentence can otherwise leave
 * several usable lines blank. The returned offset is moved back to a safe
 * whitespace boundary, keeping the source text and anchors lossless. Returning
 * `startOffset` means that even a single source character cannot fit and the
 * caller should start a new page.
 */
export function bestFittingTextEnd(
  text: string,
  startOffset: number,
  fitsThrough: (endOffset: number) => boolean,
): number {
  if (startOffset >= text.length || !fitsThrough(startOffset + 1)) return startOffset;

  let low = startOffset + 1;
  let high = text.length;
  let measuredFit = low;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (fitsThrough(middle)) {
      measuredFit = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return measuredFit >= text.length ? text.length : safeOversizedSentenceEnd(text, startOffset, measuredFit);
}

export function compareReaderAnchors(left: ReaderAnchor, right: ReaderAnchor): number {
  const block = (left.blockIndex ?? 0) - (right.blockIndex ?? 0);
  return block || left.offset - right.offset;
}

export function pageIndexForAnchor(boundaries: readonly ReaderPageBoundary[], anchor: ReaderAnchor): number {
  let low = 0;
  let high = boundaries.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const boundary = boundaries[middle];
    if (compareReaderAnchors(anchor, boundary.start) < 0) high = middle - 1;
    else if (compareReaderAnchors(anchor, boundary.end) >= 0 && middle < boundaries.length - 1) low = middle + 1;
    else return middle;
  }
  return Math.max(0, Math.min(boundaries.length - 1, low));
}

export interface RebasedPageBoundaries {
  readonly boundaries: readonly ReaderPageBoundary[];
  readonly pageIndex: number;
  readonly applied: boolean;
}

/**
 * Splits the static page containing `anchor` so a scroll-to-page transition can
 * begin exactly at the next unread sentence without dropping or duplicating
 * any source range. The shortened prefix remains reachable with PageUp.
 */
export function rebasePageBoundariesAtAnchor(
  boundaries: readonly ReaderPageBoundary[],
  anchor: ReaderAnchor,
): RebasedPageBoundaries {
  if (boundaries.length === 0) return { boundaries, pageIndex: 0, applied: false };
  const pageIndex = pageIndexForAnchor(boundaries, anchor);
  const boundary = boundaries[pageIndex];
  if (compareReaderAnchors(anchor, boundary.start) <= 0) {
    return { boundaries, pageIndex, applied: false };
  }
  if (compareReaderAnchors(anchor, boundary.end) >= 0) {
    return { boundaries, pageIndex: Math.min(pageIndex + 1, boundaries.length - 1), applied: false };
  }
  const next = [
    ...boundaries.slice(0, pageIndex),
    { ...boundary, end: anchor },
    { ...boundary, start: anchor },
    ...boundaries.slice(pageIndex + 1),
  ].map((item, index) => ({ ...item, index }));
  return { boundaries: next, pageIndex: pageIndex + 1, applied: true };
}

/**
 * Replaces the canonical range after `anchor` with pages measured from that
 * anchor. While forward measurement is still running, a split canonical
 * suffix keeps every source offset reachable without gaps or duplication.
 */
export function spliceForwardPageBoundaries(
  canonical: readonly ReaderPageBoundary[],
  anchor: ReaderAnchor,
  forward: readonly ReaderPageBoundary[],
): readonly ReaderPageBoundary[] {
  if (canonical.length === 0 || forward.length === 0) {
    return rebasePageBoundariesAtAnchor(canonical, anchor).boundaries;
  }
  const containingIndex = pageIndexForAnchor(canonical, anchor);
  const containing = canonical[containingIndex];
  const combined: ReaderPageBoundary[] = [...canonical.slice(0, containingIndex)];
  if (compareReaderAnchors(anchor, containing.start) > 0) combined.push({ ...containing, end: anchor });
  combined.push(...forward);

  const forwardEnd = forward.at(-1)!.end;
  const documentEnd = canonical.at(-1)!.end;
  if (compareReaderAnchors(forwardEnd, documentEnd) < 0) {
    const suffixIndex = pageIndexForAnchor(canonical, forwardEnd);
    const suffix = canonical[suffixIndex];
    if (compareReaderAnchors(forwardEnd, suffix.end) < 0) combined.push({ ...suffix, start: forwardEnd });
    combined.push(...canonical.slice(suffixIndex + 1));
  }

  return combined.map((boundary, index) => ({ ...boundary, index }));
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
