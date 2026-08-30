import { describe, expect, it } from 'vitest';
import type { Chapter } from '../../domain/types';
import { projectFixedDocumentSections } from './fixed-document-sections';

function chapter(index: number, input: Partial<Chapter>): Chapter {
  return {
    id: `chapter-${index}`,
    novelId: 'book-1',
    index,
    title: `${index}페이지`,
    normalizedText: '',
    textHash: `hash-${index}`,
    rawStartOffset: index - 1,
    rawEndOffset: index,
    characterCount: 0,
    paragraphCount: 1,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    ...input,
  };
}

describe('projectFixedDocumentSections', () => {
  it('keeps exact remote section ids and page bounds', () => {
    const sections = projectFixedDocumentSections('book-1', [
      chapter(1, { documentSectionId: 'release-1', documentSectionTitle: '1화' }),
      chapter(2, { documentSectionId: 'release-1', documentSectionTitle: '1화' }),
      chapter(3, { documentSectionId: 'release-2', documentSectionTitle: '2화' }),
    ]);

    expect(sections).toEqual([
      { id: 'release-1', title: '1화', startPageIndex: 0, pageCount: 2 },
      { id: 'release-2', title: '2화', startPageIndex: 2, pageCount: 1 },
    ]);
  });

  it('projects migrated hosted pages without remote ids as separate bounded releases', () => {
    const sections = projectFixedDocumentSections('book-1', [
      chapter(1, {
        title: '특별편 · 1페이지',
        documentSectionTitle: '특별편',
        documentSectionIndex: 1,
        documentPageIndexInSection: 1,
      }),
      chapter(2, {
        title: '특별편 · 2페이지',
        documentSectionTitle: '특별편',
        documentSectionIndex: 1,
        documentPageIndexInSection: 2,
      }),
      chapter(3, {
        title: '특별편 · 1페이지',
        documentSectionTitle: '특별편',
        documentSectionIndex: 1,
        documentPageIndexInSection: 1,
      }),
    ]);

    expect(sections).toEqual([
      {
        id: 'legacy-document-section:book-1:1:0',
        title: '특별편',
        startPageIndex: 0,
        pageCount: 2,
      },
      {
        id: 'legacy-document-section:book-1:1:2',
        title: '특별편',
        startPageIndex: 2,
        pageCount: 1,
      },
    ]);
  });

  it('recovers contiguous sections directly from deterministic legacy page titles', () => {
    expect(
      projectFixedDocumentSections('book-1', [
        chapter(1, { title: '1화 · 1페이지' }),
        chapter(2, { title: '1화 · 2페이지' }),
        chapter(3, { title: '2화 · 1페이지' }),
      ]).map(({ title, startPageIndex, pageCount }) => ({ title, startPageIndex, pageCount })),
    ).toEqual([
      { title: '1화', startPageIndex: 0, pageCount: 2 },
      { title: '2화', startPageIndex: 2, pageCount: 1 },
    ]);
  });
});
