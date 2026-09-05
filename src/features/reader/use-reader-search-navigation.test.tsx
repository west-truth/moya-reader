import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chapter, Paragraph } from '../../domain/types';
import type { ReaderQueries } from '../../repositories/reader-repository';
import { useReaderSearch } from './use-reader-search';

const chapters: Chapter[] = ['a', 'b'].map((id, index) => ({
  id,
  novelId: 'book',
  index: index + 1,
  title: id,
  normalizedText: '',
  textHash: id,
  rawStartOffset: 0,
  rawEndOffset: 20,
  characterCount: 20,
  paragraphCount: 2,
  createdAt: '',
  updatedAt: '',
}));
const paragraphs: Paragraph[] = ['a', 'a', 'b', 'b'].map((chapterId, index) => ({
  id: `p${index}`,
  novelId: 'book',
  chapterId,
  index: (index % 2) + 1,
  text: 'needle 본문',
  startOffsetInChapter: 0,
  endOffsetInChapter: 9,
  textHash: `p${index}`,
}));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('search navigation between chapters', () => {
  it.each(['book', 'chapter'] as const)('keeps the correct query identity for %s scope', async (scope) => {
    const searchParagraphPage = vi.fn<ReaderQueries['searchParagraphPage']>(async (request) => ({
      paragraphs: request.scope === 'book' ? paragraphs : paragraphs.filter((p) => p.chapterId === request.chapterId),
      capped: false,
      scannedRows: 4,
      scannedTextCharacters: 36,
    }));
    const repository = { searchParagraphPage } as unknown as ReaderQueries;
    const scrollToParagraph = vi.fn(async () => true);
    const notify = vi.fn();
    let search!: ReturnType<typeof useReaderSearch>;
    let renderer!: ReactTestRenderer;
    const openChapter = vi.fn(async (chapter: Chapter) => renderer.update(<Probe chapter={chapter} />));
    function Probe({ chapter }: { chapter: Chapter }) {
      search = useReaderSearch({
        repository,
        novel: { id: 'book' },
        chapter,
        chapters,
        scrollToParagraph,
        openChapter,
        notify,
      });
      return null;
    }
    try {
      await act(async () => {
        renderer = create(<Probe chapter={chapters[0]} />);
      });
      await act(async () => {
        search.setScope(scope);
        search.setQuery('needle');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      if (scope === 'book') {
        await act(async () => search.goToResult(paragraphs[2], 2));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(200);
        });
        expect(searchParagraphPage).toHaveBeenCalledTimes(1);
        expect(search.cursor).toBe(2);
        await act(async () => search.jump(1));
        expect(search.cursor).toBe(3);
        expect(scrollToParagraph).toHaveBeenLastCalledWith('p3');
        expect(openChapter).toHaveBeenCalledTimes(1);
      } else {
        await act(async () => renderer.update(<Probe chapter={chapters[1]} />));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(200);
        });
        expect(searchParagraphPage).toHaveBeenCalledTimes(2);
        expect(search.matches.map((p) => p.id)).toEqual(['p2', 'p3']);
        expect(search.cursor).toBe(0);
      }
    } finally {
      act(() => renderer?.unmount());
    }
  });
});
