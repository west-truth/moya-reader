import { describe, expect, it, vi } from 'vitest';
import type { Paragraph, ReaderAnchor, ReaderPageBoundary } from '../../domain/types';
import { ReaderPageWindow } from './reader-page-window';

const anchor = (index: number, offset = 0): ReaderAnchor => ({
  bookId: 'book',
  contentRevisionId: 'revision',
  sectionId: 'chapter',
  blockId: `p${index}`,
  blockIndex: index,
  offset,
});
const page = (start: number, end: number): ReaderPageBoundary => ({ index: 0, start: anchor(start), end: anchor(end) });
const paragraph = (index: number) => ({ id: `p${index}`, index: index + 1, text: '앞뒤 페이지의 원문' }) as Paragraph;

describe('source-addressed page window', () => {
  it('reflows the opening forward when a reverse fit strands a character beside the chapter heading', async () => {
    const opening = page(0, 6);
    const measure = vi.fn(async (edge: ReaderAnchor, direction: -1 | 1) =>
      direction < 0 ? { index: 0, start: anchor(0, 1), end: edge } : opening,
    );
    const window = new ReaderPageWindow(measure, async (index) => paragraph(index), new AbortController().signal);
    expect(await window.adjacent(anchor(7), -1)).toEqual(opening);
    expect(measure.mock.calls).toEqual([
      [anchor(7), -1],
      [anchor(0), 1],
    ]);
    expect(window.snapshot()).toEqual([opening]);
    expect(await window.adjacent(anchor(6), -1)).toEqual(opening);
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('keeps a deep previous page inside a single oversized paragraph', async () => {
    const opening = { index: 0, start: anchor(0), end: anchor(0, 600) };
    const previous = { index: 0, start: anchor(0, 5000), end: anchor(0, 5600) };
    const measure = vi.fn(async (_edge: ReaderAnchor, direction: -1 | 1) => (direction < 0 ? previous : opening));
    const window = new ReaderPageWindow(measure, async (index) => paragraph(index), new AbortController().signal);
    expect(await window.adjacent(anchor(0, 5600), -1)).toEqual(previous);
    expect(await window.adjacent(anchor(0, 5600), -1)).toEqual(previous);
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('measures around a deep resume without scanning the chapter prefix, and reverses exactly', async () => {
    const measure = vi.fn(async (edge: ReaderAnchor, direction: -1 | 1) =>
      direction > 0 ? page(edge.blockIndex!, edge.blockIndex! + 3) : page(edge.blockIndex! - 4, edge.blockIndex!),
    );
    const window = new ReaderPageWindow(measure, async (index) => paragraph(index), new AbortController().signal);
    const previous = await window.at(anchor(9000), 'previous-page');
    expect(previous).toEqual(page(8996, 9000));
    const next = await window.adjacent(previous!.end, 1);
    expect(next).toEqual(page(9000, 9003));
    expect(await window.adjacent(next!.start, -1)).toEqual(previous);
    expect(measure.mock.calls.map(([edge]) => edge.blockIndex)).toEqual([9000, 9000]);
  });

  it('does not clamp an uncached resume to the end of a partial map', async () => {
    const measure = vi.fn(async () => page(9000, 9003));
    const window = new ReaderPageWindow(measure, async (index) => paragraph(index), new AbortController().signal);
    window.seed([page(0, 3), page(3, 6)]);
    expect(await window.at(anchor(9000), 'contain')).toEqual(page(9000, 9003));
    expect(measure).toHaveBeenCalledWith(anchor(9000), 1);
  });

  it('deduplicates prefetch with a foreground turn and rejects late results after cancellation', async () => {
    let resolve!: (value: ReaderPageBoundary) => void;
    const measure = vi.fn(
      () =>
        new Promise<ReaderPageBoundary>((done) => {
          resolve = done;
        }),
    );
    const controller = new AbortController();
    const window = new ReaderPageWindow(measure, async (index) => paragraph(index), controller.signal);
    const prefetch = window.adjacent(anchor(9000), 1);
    const foreground = window.adjacent(anchor(9000), 1);
    expect(measure).toHaveBeenCalledOnce();
    controller.abort();
    resolve(page(9000, 9003));
    expect((await Promise.allSettled([prefetch, foreground])).every((result) => result.status === 'rejected')).toBe(
      true,
    );
    expect(window.snapshot()).toEqual([]);
  });

  it('keeps fragment caches tied to source ranges rather than a moving page number', async () => {
    const window = new ReaderPageWindow(
      async () => undefined,
      async (index) => paragraph(index),
      new AbortController().signal,
    );
    const first = { index: 0, start: anchor(3, 2), end: anchor(3, 5) };
    const second = { index: 0, start: anchor(3, 5), end: anchor(4) };
    expect(await window.materialize(first)).toMatchObject([{ paragraphIndex: 3, startOffset: 2, endOffset: 5 }]);
    expect(await window.materialize(second)).toMatchObject([
      { paragraphIndex: 3, startOffset: 5, endOffset: paragraph(3).text.length },
    ]);
    expect(window.snapshot()).toHaveLength(0);
  });

  it('bounds measured-page memory during a long session', async () => {
    const window = new ReaderPageWindow(
      async (edge) => page(edge.blockIndex!, edge.blockIndex! + 1),
      async (index) => paragraph(index),
      new AbortController().signal,
      8,
    );
    for (let index = 0; index < 100; index++) await window.adjacent(anchor(index), 1);
    expect(window.snapshot()).toHaveLength(8);
    expect(window.snapshot()[0].start.blockIndex).toBe(92);
  });
});
