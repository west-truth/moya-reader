import { describe, expect, it, vi } from 'vitest';
import type { ParagraphPage } from '../../domain/types';
import type { BulkBookSource } from '../../repositories/reader-repository';
import {
  loadAnalysisParagraphs,
  loadBundleAnalysisContext,
  openAnalysisParagraphSource,
} from './analysis-paragraph-source';

function page(pageIndex: number, indexes: number[], chapterId = 'chapter-1'): ParagraphPage {
  return {
    id: `page-${pageIndex}`,
    novelId: 'book-1',
    chapterId,
    pageIndex,
    startParagraphIndex: Math.min(...indexes),
    endParagraphIndex: Math.max(...indexes),
    paragraphs: indexes.map((index) => ({
      id: `paragraph-${index}`,
      novelId: 'book-1',
      chapterId,
      index,
      text: `Paragraph ${index}`,
      startOffsetInChapter: index,
      endOffsetInChapter: index + 1,
      textHash: `sha256:${index}`,
    })),
    textHash: `sha256:page-${pageIndex}`,
  };
}

describe('analysis paragraph source', () => {
  it('pins a revision-capable source and collects bounded pages in paragraph order', async () => {
    const pinned: BulkBookSource = {
      iterateParagraphPages: async function* (request) {
        expect(request.batchSize).toBe(4);
        yield page(1, [3]);
        yield page(0, [2, 1]);
      },
    };
    const openContentRevision = vi.fn(async () => pinned);
    const source = await openAnalysisParagraphSource({ iterateParagraphPages: vi.fn(), openContentRevision }, 'book-1');
    const paragraphs = await loadAnalysisParagraphs(source, 'chapter-1', new AbortController().signal);

    expect(openContentRevision).toHaveBeenCalledWith('book-1');
    expect(paragraphs.map((paragraph) => paragraph.index)).toEqual([1, 2, 3]);
  });

  it('stops between page batches when cancelled', async () => {
    const controller = new AbortController();
    const source: BulkBookSource = {
      iterateParagraphPages: async function* () {
        yield page(0, [1]);
        controller.abort();
        yield page(1, [2]);
      },
    };

    await expect(loadAnalysisParagraphs(source, 'chapter-1', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('loads a bundle from one pinned revision without concurrent chapter materialization', async () => {
    const loadedChapters: string[] = [];
    const pinned: BulkBookSource = {
      iterateParagraphPages: async function* (request) {
        loadedChapters.push(request.chapterId);
        yield page(0, [1], request.chapterId);
      },
    };
    const repository = {
      iterateParagraphPages: vi.fn(),
      openContentRevision: vi.fn(async () => pinned),
      listCharacters: vi.fn(async () => []),
      listCharacterRelations: vi.fn(async () => []),
      listCorrections: vi.fn(async () => []),
    };
    const chapters = [
      { id: 'chapter-1', novelId: 'book-1', index: 1 },
      { id: 'chapter-2', novelId: 'book-1', index: 2 },
    ].map((chapter) => ({
      ...chapter,
      title: chapter.id,
      normalizedText: '',
      textHash: `sha256:${chapter.id}`,
      rawStartOffset: 0,
      rawEndOffset: 1,
      characterCount: 1,
      paragraphCount: 1,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    }));

    const result = await loadBundleAnalysisContext(repository, 'book-1', chapters, new AbortController().signal);

    expect(repository.openContentRevision).toHaveBeenCalledOnce();
    expect(loadedChapters).toEqual(['chapter-1', 'chapter-2']);
    expect(result.chapterSources.map((source) => source.chapter.id)).toEqual(loadedChapters);
  });
});
