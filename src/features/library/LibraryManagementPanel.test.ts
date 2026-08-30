import { describe, expect, it, vi } from 'vitest';
import type { Novel } from '../../domain/types';
import { mayCloseMetadataEditor } from './LibraryManagementPanel';
import { buildMetadataPatch, normalizeMetadataTags } from './metadata-editor-draft';
import { metadataEditCanRebase } from './useLibraryManagementController';

function novel(overrides: Partial<Novel> = {}): Novel {
  return {
    id: 'book-1',
    title: '기존 제목',
    sourceFileName: '기존 제목.txt',
    normalizedTextHash: 'hash',
    totalChapters: 1,
    totalCharacters: 10,
    totalParagraphs: 1,
    coverSeed: 1,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    metadataRevision: 2,
    ...overrides,
  } as Novel;
}

describe('mayCloseMetadataEditor', () => {
  it('closes clean editors without asking for confirmation', () => {
    const confirmDiscard = vi.fn(() => false);

    expect(mayCloseMetadataEditor(false, confirmDiscard)).toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it('keeps a dirty editor open when discarding is rejected', () => {
    const confirmDiscard = vi.fn(() => false);

    expect(mayCloseMetadataEditor(true, confirmDiscard)).toBe(false);
    expect(confirmDiscard).toHaveBeenCalledWith('저장하지 않은 책 정보 변경을 버릴까요?');
  });

  it('closes a dirty editor after discard confirmation', () => {
    expect(mayCloseMetadataEditor(true, () => true)).toBe(true);
  });
});

describe('normalizeMetadataTags', () => {
  it('trims, removes blanks, and preserves the first occurrence order', () => {
    expect(normalizeMetadataTags([' 판타지 ', '', '성장', '판타지', '  성장  ', '모험'])).toEqual([
      '판타지',
      '성장',
      '모험',
    ]);
  });
});

describe('metadata editor patch and rebase', () => {
  const unchangedDraft = {
    title: '기존 제목',
    author: '',
    seriesTitle: '',
    seriesIndex: '',
    tags: [] as string[],
    description: '',
    language: '',
    fit: 'crop' as const,
    positionX: 50,
    positionY: 50,
  };

  it('does not create a metadata mutation for an unchanged form', () => {
    expect(buildMetadataPatch(novel(), unchangedDraft, 'keep')).toEqual({});
  });

  it('sends only fields actually edited by the user', () => {
    expect(
      buildMetadataPatch(novel(), { ...unchangedDraft, author: ' 새 작가 ', fit: 'contain', positionX: 40 }, 'keep'),
    ).toEqual({ author: '새 작가', coverFit: 'contain', coverPositionX: 40 });
  });

  it('leaves cover layout to the cover upload when replacing the cover', () => {
    expect(buildMetadataPatch(novel(), { ...unchangedDraft, fit: 'contain', positionX: 10 }, 'replace')).toEqual({});
  });

  it('rebases an edit when only unrelated server fields changed', () => {
    const base = novel({ author: '작가' });
    const current = novel({ author: '작가', favorite: true, metadataRevision: 3 });
    expect(metadataEditCanRebase(base, current, { title: '새 제목' })).toBe(true);
  });

  it('keeps the draft in conflict when the same target field changed elsewhere', () => {
    const base = novel({ author: '기존 작가' });
    const current = novel({ author: '자동 적용 작가', metadataRevision: 3 });
    expect(metadataEditCanRebase(base, current, { author: '직접 입력 작가' })).toBe(false);
  });
});
