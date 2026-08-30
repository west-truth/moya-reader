import { describe, expect, it } from 'vitest';
import type { Chapter } from '../../domain/types';
import {
  buildChapterListModel,
  initialChapterPage,
  paginateChapterRows,
  projectChapterTtsDuration,
} from './chapters-screen-model';

function chapter(index: number): Chapter {
  return {
    id: `chapter-${index}`,
    novelId: 'novel-1',
    index,
    title: `${index}화`,
    normalizedText: '본문',
    textHash: `hash-${index}`,
    rawStartOffset: index * 10,
    rawEndOffset: index * 10 + 9,
    characterCount: index * 100,
    paragraphCount: index,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  };
}

describe('chapters screen model', () => {
  it('projects actual TTS duration when available and a labeled estimate otherwise', () => {
    expect(projectChapterTtsDuration(600)).toEqual({ seconds: 120, label: '예상 2분', source: 'estimated' });
    expect(projectChapterTtsDuration(600, 91)).toEqual({ seconds: 91, label: '2분', source: 'actual' });
    expect(projectChapterTtsDuration(0)).toEqual({ seconds: 0, label: '예상 0분', source: 'estimated' });
  });

  it('keeps character, paragraph, annotation and TTS metadata on rows', () => {
    const model = buildChapterListModel({
      chapters: [chapter(1)],
      query: '',
      readFilter: 'all',
      sort: 'asc',
      currentChapter: chapter(1),
      annotationCounts: new Map([['chapter-1', { bookmarks: 1, highlights: 2, notes: 3 }]]),
      actualTtsDurationSeconds: new Map([['chapter-1', 61]]),
    });
    expect(model.rows[0]).toMatchObject({
      characterCountLabel: '100자',
      paragraphCountLabel: '1문단',
      ttsDuration: { seconds: 61, label: '2분', source: 'actual' },
      annotationCounts: { bookmarks: 1, highlights: 2, notes: 3 },
    });
  });

  it('finds the current page and clamps requested pages to ten rows', () => {
    const chapters = Array.from({ length: 24 }, (_, index) => chapter(index + 1));
    const model = buildChapterListModel({
      chapters,
      query: '',
      readFilter: 'all',
      sort: 'asc',
      currentChapter: chapters[14],
      annotationCounts: new Map(),
    });
    expect(initialChapterPage(model.rows)).toBe(2);
    expect(paginateChapterRows(model.rows, 99)).toMatchObject({
      page: 3,
      pageCount: 3,
      rangeStart: 21,
      rangeEnd: 24,
      resultCount: 24,
    });
    expect(paginateChapterRows(model.rows, 2).rows.map((row) => row.chapter.index)).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
  });

  it('does not infer skipped fixed-document sections as read from a later current page', () => {
    const chapters = Array.from({ length: 6 }, (_, index) => ({
      ...chapter(index + 1),
      documentSectionId: `chapter:${index + 1}`,
      documentSectionReadAt: index < 3 || index === 5 ? `2026-08-30T01:0${index + 1}:00.000Z` : undefined,
    }));

    const model = buildChapterListModel({
      chapters,
      query: '',
      readFilter: 'all',
      sort: 'asc',
      currentChapter: chapters[5],
      readPolicy: 'document_section',
      annotationCounts: new Map(),
    });

    expect(model.rows.map((row) => row.isRead)).toEqual([true, true, true, false, false, true]);
    expect(model.rows.map((row) => row.isCurrent)).toEqual([false, false, false, false, false, true]);
  });
});
