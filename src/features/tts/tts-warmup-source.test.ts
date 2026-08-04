import { describe, expect, it, vi } from 'vitest';
import type { Paragraph, ParagraphPage } from '../../domain/types';
import { loadTTSWarmupParagraphs } from './tts-warmup-source';

function paragraph(id: string, index: number, chapterId = 'chapter-1'): Paragraph {
  return {
    id,
    novelId: 'book-1',
    chapterId,
    index,
    text: `paragraph ${index}`,
    startOffsetInChapter: 0,
    endOffsetInChapter: 10,
    textHash: `hash-${id}`,
  };
}

function page(pageIndex: number, paragraphs: Paragraph[]): ParagraphPage {
  return {
    id: `page-${pageIndex}`,
    novelId: 'book-1',
    chapterId: 'chapter-1',
    pageIndex,
    startParagraphIndex: paragraphs[0]?.index ?? 0,
    endParagraphIndex: paragraphs[paragraphs.length - 1]?.index ?? 0,
    paragraphs,
    textHash: `page-hash-${pageIndex}`,
  };
}

describe('loadTTSWarmupParagraphs', () => {
  it('prefers the bulk page iterable for dense warmup sources', async () => {
    const target = Array.from({ length: 12 }, (_, index) => paragraph(`p-${index + 1}`, index + 1));
    const getParagraph = vi.fn(async () => undefined);
    const getParagraphPage = vi.fn(async () => undefined);
    const iterateParagraphPages = vi.fn(async function* () {
      yield page(0, target);
    });

    const result = await loadTTSWarmupParagraphs({
      source: { getParagraph, getParagraphPage, iterateParagraphPages },
      chapterId: 'chapter-1',
      paragraphCount: target.length,
      candidateParagraphIds: target.map((item) => item.id),
      signal: new AbortController().signal,
      preferPageReads: true,
    });

    expect(result.map((item) => item.id)).toEqual(target.map((item) => item.id));
    expect(iterateParagraphPages).toHaveBeenCalledTimes(1);
    expect(getParagraphPage).not.toHaveBeenCalled();
    expect(getParagraph).not.toHaveBeenCalled();
  });

  it('uses cached rows and bounded page reads instead of one request per paragraph', async () => {
    const cached = paragraph('p-1', 1);
    const target = Array.from({ length: 12 }, (_, index) => paragraph(`p-${index + 1}`, index + 1));
    const getParagraph = vi.fn(async () => undefined);
    const getParagraphPage = vi.fn(async (_chapterId: string, pageIndex: number) =>
      pageIndex === 0 ? page(0, target) : undefined,
    );

    const result = await loadTTSWarmupParagraphs({
      source: { getParagraph, getParagraphPage },
      chapterId: 'chapter-1',
      paragraphCount: 400,
      candidateParagraphIds: target.map((item) => item.id),
      cachedParagraph: (paragraphId) => (paragraphId === cached.id ? cached : undefined),
      signal: new AbortController().signal,
      preferPageReads: true,
    });

    expect(result.map((item) => item.id)).toEqual(target.map((item) => item.id));
    expect(getParagraphPage).toHaveBeenCalledTimes(1);
    expect(getParagraph).not.toHaveBeenCalled();
  });

  it('falls back to direct reads for sparse candidates and preserves chapter ownership', async () => {
    const foreign = paragraph('foreign', 1, 'chapter-2');
    const expected = paragraph('p-2', 2);
    const getParagraph = vi.fn(async (paragraphId: string, signal?: AbortSignal) =>
      paragraphId === expected.id && !signal?.aborted ? expected : paragraphId === foreign.id ? foreign : undefined,
    );
    const getParagraphPage = vi.fn(async () => undefined);

    const result = await loadTTSWarmupParagraphs({
      source: { getParagraph, getParagraphPage },
      chapterId: 'chapter-1',
      paragraphCount: 20,
      candidateParagraphIds: [foreign.id, expected.id, expected.id],
      signal: new AbortController().signal,
    });

    expect(result).toEqual([expected]);
    expect(getParagraphPage).not.toHaveBeenCalled();
    expect(getParagraph).toHaveBeenCalledTimes(2);
    expect(getParagraph).toHaveBeenCalledWith(expected.id, expect.any(AbortSignal));
  });

  it('stops between page reads when cancelled', async () => {
    const controller = new AbortController();
    const getParagraphPage = vi.fn(async () => {
      controller.abort();
      return page(0, []);
    });

    await expect(
      loadTTSWarmupParagraphs({
        source: { getParagraph: async () => undefined, getParagraphPage },
        chapterId: 'chapter-1',
        paragraphCount: 400,
        candidateParagraphIds: Array.from({ length: 12 }, (_, index) => `p-${index}`),
        signal: controller.signal,
        preferPageReads: true,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(getParagraphPage).toHaveBeenCalledTimes(1);
  });
});
