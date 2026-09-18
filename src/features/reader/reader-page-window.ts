import type { Paragraph, ReaderAnchor, ReaderPageBoundary } from '../../domain/types';
import { compareReaderAnchors, type ReaderPageFragment } from './reader-pagination-model';

export function pageContainsAnchor(page: ReaderPageBoundary, anchor: ReaderAnchor): boolean {
  return compareReaderAnchors(page.start, anchor) <= 0 && compareReaderAnchors(anchor, page.end) < 0;
}

const edgeKey = (anchor: ReaderAnchor) => `${anchor.blockIndex ?? 0}:${anchor.offset}`;
const pageKey = (page: ReaderPageBoundary) => `${edgeKey(page.start)}-${edgeKey(page.end)}`;

/** A bounded source-addressed cache. Missing neighbors are measured on demand, never treated as chapter ends. */
export class ReaderPageWindow {
  private readonly pages = new Map<string, ReaderPageBoundary>();
  private readonly fragments = new Map<string, readonly ReaderPageFragment[]>();
  private readonly pending = new Map<string, Promise<ReaderPageBoundary | undefined>>();

  constructor(
    private readonly measure: (edge: ReaderAnchor, direction: -1 | 1) => Promise<ReaderPageBoundary | undefined>,
    private readonly getParagraph: (index: number) => Promise<Paragraph | undefined>,
    private readonly signal: AbortSignal,
    private readonly limit = 96,
  ) {}

  seed(pages: readonly ReaderPageBoundary[]): void {
    for (const page of pages) this.remember(page);
  }

  private remember(page: ReaderPageBoundary): ReaderPageBoundary {
    this.signal.throwIfAborted();
    const key = pageKey(page);
    this.pages.delete(key);
    this.pages.set(key, page);
    while (this.pages.size > this.limit) this.pages.delete(this.pages.keys().next().value!);
    return page;
  }

  async adjacent(edge: ReaderAnchor, direction: -1 | 1): Promise<ReaderPageBoundary | undefined> {
    this.signal.throwIfAborted();
    const cached = [...this.pages.values()]
      .reverse()
      .find((page) => compareReaderAnchors(direction > 0 ? page.start : page.end, edge) === 0);
    if (cached) return this.remember(cached);
    const key = `${direction}:${edgeKey(edge)}`;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.measure(edge, direction).then((page) => page && this.remember(page));
      this.pending.set(key, pending);
    }
    try {
      return await pending;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }

  async at(anchor: ReaderAnchor, placement: 'contain' | 'page-start' | 'previous-page') {
    this.signal.throwIfAborted();
    if (placement === 'contain') {
      const cached = [...this.pages.values()].reverse().find((page) => pageContainsAnchor(page, anchor));
      if (cached) return this.remember(cached);
    }
    if (placement === 'previous-page') {
      return (await this.adjacent(anchor, -1)) ?? this.adjacent(anchor, 1);
    }
    return (await this.adjacent(anchor, 1)) ?? this.adjacent(anchor, -1);
  }

  async materialize(page: ReaderPageBoundary): Promise<readonly ReaderPageFragment[]> {
    this.signal.throwIfAborted();
    const key = pageKey(page);
    const cached = this.fragments.get(key);
    if (cached) return cached;
    const fragments: ReaderPageFragment[] = [];
    const startIndex = page.start.blockIndex ?? 0;
    const endIndex = page.end.blockIndex ?? startIndex;
    for (let index = startIndex; index <= endIndex; index += 1) {
      if (index === endIndex && page.end.offset === 0 && index > startIndex) break;
      const paragraph = await this.getParagraph(index);
      this.signal.throwIfAborted();
      if (!paragraph) throw new Error(`Paragraph ${index} is unavailable while materializing a page.`);
      fragments.push({
        paragraph,
        paragraphIndex: index,
        startOffset: index === startIndex ? page.start.offset : 0,
        endOffset: index === endIndex ? page.end.offset : paragraph.text.length,
      });
    }
    this.fragments.set(key, fragments);
    while (this.fragments.size > 12) this.fragments.delete(this.fragments.keys().next().value!);
    return fragments;
  }

  snapshot(): readonly ReaderPageBoundary[] {
    return [...this.pages.values()]
      .sort((a, b) => compareReaderAnchors(a.start, b.start))
      .map((page, index) => ({ ...page, index }));
  }
}
