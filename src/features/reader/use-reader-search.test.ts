import { describe, expect, it, vi } from 'vitest';
import type { Paragraph } from '../../domain/types';
import type { ReaderQueries } from '../../repositories/reader-repository';
import { collectReaderSearchMatches } from './use-reader-search';

function paragraph(index: number): Paragraph {
  return {
    id: `paragraph-${index}`,
    novelId: 'book-1',
    chapterId: 'chapter-1',
    index,
    text: `needle ${index}`,
    startOffsetInChapter: index * 10,
    endOffsetInChapter: index * 10 + 8,
    textHash: `hash-${index}`,
  };
}

describe('collectReaderSearchMatches', () => {
  it('continues through scan-only pages and preserves page order', async () => {
    const searchParagraphPage = vi.fn<ReaderQueries['searchParagraphPage']>(async (request) => {
      if (!request.cursor) {
        return {
          paragraphs: [],
          nextCursor: 'cursor-1',
          capped: false,
          scannedRows: 20,
          scannedTextCharacters: 200,
        };
      }
      return {
        paragraphs: [paragraph(1), paragraph(2)],
        capped: false,
        scannedRows: 2,
        scannedTextCharacters: 16,
      };
    });
    const signal = new AbortController().signal;

    const result = await collectReaderSearchMatches(
      { searchParagraphPage },
      { scope: 'chapter', chapterId: 'chapter-1', query: 'needle', signal },
      200,
    );

    expect(result).toEqual({ matches: [paragraph(1), paragraph(2)], capped: false });
    expect(searchParagraphPage).toHaveBeenCalledTimes(2);
    expect(searchParagraphPage).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'cursor-1', signal }));
  });

  it('rejects a late page after its request generation is aborted', async () => {
    let resolvePage: ((page: Awaited<ReturnType<ReaderQueries['searchParagraphPage']>>) => void) | undefined;
    const searchParagraphPage = vi.fn<ReaderQueries['searchParagraphPage']>(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = collectReaderSearchMatches(
      { searchParagraphPage },
      { scope: 'chapter', chapterId: 'chapter-1', query: 'needle', signal: controller.signal },
      200,
    );

    controller.abort();
    resolvePage?.({
      paragraphs: [paragraph(1)],
      capped: false,
      scannedRows: 1,
      scannedTextCharacters: 8,
    });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
