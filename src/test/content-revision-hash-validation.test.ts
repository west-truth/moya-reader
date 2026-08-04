import { describe, expect, it } from 'vitest';
import { integrityHash } from '../domain/id-hash-contract';
import type { Chapter, Novel, Paragraph, ParagraphPage } from '../domain/types';
import { createContentRevisionValidationState, validateContentRevisionPageBatch } from '../storage/content-revisions';

function fixture() {
  const now = '2026-07-10T00:00:00.000Z';
  const text = 'tagged paragraph';
  const paragraph: Paragraph = {
    id: 'paragraph_0123456789abcdef0123456789abcdef',
    novelId: 'novel_0123456789abcdef0123456789abcdef',
    chapterId: 'chapter_0123456789abcdef0123456789abcdef',
    index: 1,
    text,
    startOffsetInChapter: 0,
    endOffsetInChapter: text.length,
    textHash: integrityHash(text),
  };
  const chapter: Chapter = {
    id: paragraph.chapterId,
    novelId: paragraph.novelId,
    index: 1,
    title: 'Chapter 1',
    normalizedText: text,
    textHash: integrityHash(text),
    rawStartOffset: 0,
    rawEndOffset: text.length,
    characterCount: text.length,
    paragraphCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const novel: Novel = {
    id: paragraph.novelId,
    title: 'Hash fixture',
    sourceFileName: 'hash-fixture.txt',
    sourceEncoding: 'utf-8',
    rawText: text,
    normalizedText: text,
    rawTextHash: integrityHash(text),
    normalizedTextHash: integrityHash(text),
    createdAt: now,
    updatedAt: now,
    totalChapters: 1,
    totalCharacters: text.length,
    totalParagraphs: 1,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
  };
  const page: ParagraphPage = {
    id: 'page_0123456789abcdef0123456789abcdef',
    novelId: novel.id,
    chapterId: chapter.id,
    pageIndex: 0,
    startParagraphIndex: 1,
    endParagraphIndex: 1,
    paragraphs: [paragraph],
    textHash: integrityHash(JSON.stringify([paragraph.textHash])),
  };
  return { chapter, novel, page };
}

describe('content revision hash validation', () => {
  it('accepts a current tagged page hash', () => {
    const { chapter, novel, page } = fixture();
    const state = createContentRevisionValidationState({
      novel,
      chapters: [chapter],
      expected: { chapterCount: 1, pageCount: 1, paragraphCount: 1 },
    });

    expect(() => validateContentRevisionPageBatch(state, [page])).not.toThrow();
  });

  it('rejects a mismatched tagged page hash instead of skipping verification', () => {
    const { chapter, novel, page } = fixture();
    const state = createContentRevisionValidationState({
      novel,
      chapters: [chapter],
      expected: { chapterCount: 1, pageCount: 1, paragraphCount: 1 },
    });

    expect(() =>
      validateContentRevisionPageBatch(state, [{ ...page, textHash: integrityHash('tampered page') }]),
    ).toThrow(/page hash mismatch/);
  });
});
