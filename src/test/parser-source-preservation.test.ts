import { describe, expect, it } from 'vitest';
import { normalizeNovelText, parseNovelFile, parseNovelFileForImport } from '../domain/parser';
import type { Chapter, Paragraph, ParsedNovelImportChapterSource } from '../domain/types';

function toBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

async function collectImportParagraphs(source: ParsedNovelImportChapterSource): Promise<Paragraph[]> {
  const paragraphs: Paragraph[] = [];
  for await (const item of source) paragraphs.push(...item.paragraphs);
  return paragraphs;
}

function expectNormalizedSourceCoverage(chapters: Chapter[], paragraphs: Paragraph[], normalizedText: string): void {
  expect(chapters.length).toBeGreaterThan(0);

  let nextNormalizedOffset = 0;
  for (const chapter of chapters) {
    expect(chapter.rawStartOffset).toBe(nextNormalizedOffset);
    expect(chapter.rawEndOffset).toBeGreaterThanOrEqual(chapter.rawStartOffset);
    nextNormalizedOffset = chapter.rawEndOffset;
    for (const paragraph of paragraphs.filter((item) => item.chapterId === chapter.id)) {
      expect(normalizedText.slice(chapter.rawStartOffset, chapter.rawEndOffset)).toContain(paragraph.text);
    }
  }

  expect(nextNormalizedOffset).toBe(normalizedText.length);
  expect(chapters.map((chapter) => normalizedText.slice(chapter.rawStartOffset, chapter.rawEndOffset)).join('')).toBe(
    normalizedText,
  );
}

describe('novel parser source preservation', () => {
  it('folds a short prefix into the first real chapter without losing source text', async () => {
    const parsed = await parseNovelFile(
      '짧은 머리말.txt',
      toBuffer(`업로드 공지: 맞춤법 교정본입니다.

제 1화 시작

첫 번째 본문은 독자가 원문 보존 여부를 확인할 수 있도록 충분한 내용을 담고 있다.`),
      'utf-8',
    );

    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['제 1화 시작']);
    expect(parsed.chapters[0]).toMatchObject({
      normalizedText: expect.stringContaining('업로드 공지: 맞춤법 교정본입니다.'),
      paragraphCount: 3,
    });
    expectNormalizedSourceCoverage(parsed.chapters, parsed.paragraphs, parsed.novel.normalizedText);
  });

  it('folds an empty heading into the previous chapter without losing its source line', async () => {
    const parsed = await parseNovelFile(
      '빈 화.txt',
      toBuffer(`제 1화 시작

첫 번째 화의 본문이다.

제 2화 비어 있는 방

제 3화 귀환

세 번째 화의 본문이다.`),
      'utf-8',
    );

    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['제 1화 시작', '제 3화 귀환']);
    expect(parsed.chapters[0]?.normalizedText).toContain('제 2화 비어 있는 방');
    expectNormalizedSourceCoverage(parsed.chapters, parsed.paragraphs, parsed.novel.normalizedText);
  });

  it('preserves source coverage when heading rules change in the middle of a mixed-mode file', async () => {
    const parsed = await parseNovelFile(
      '중간 혼합 규칙.txt',
      toBuffer(`Chapter 1 - Start

The first body is long enough to establish an explicit chapter before the exporter changes its heading format.

2. Middle Shift

The second body keeps enough source text for a numbered dot heading to be accepted as the middle chapter.

[003]

The third body follows another producer format while preserving every non-whitespace source character exactly once.`),
      'utf-8',
      { chapterSplitMode: 'mixed' },
    );

    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['Chapter 1 - Start', '2. Middle Shift', '[003]']);
    expectNormalizedSourceCoverage(parsed.chapters, parsed.paragraphs, parsed.novel.normalizedText);
  });

  it('folds prefix and empty-heading content into the one-shot import result', async () => {
    const source = `개정판 업로드 공지입니다.

제 1화 시작

첫 번째 화의 본문이다.

제 2화 비어 있는 방

제 3화 귀환

세 번째 화의 본문이다.`;
    const parsed = await parseNovelFileForImport('가져오기 보존.txt', toBuffer(source), 'utf-8');
    const paragraphs = await collectImportParagraphs(parsed.consumeChapterParagraphs());

    expect(parsed.novel).toMatchObject({ rawText: '', normalizedText: '' });
    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['제 1화 시작', '제 3화 귀환']);
    expect(paragraphs.map((paragraph) => paragraph.text)).toContain('제 2화 비어 있는 방');
    expectNormalizedSourceCoverage(parsed.chapters, paragraphs, normalizeNovelText(source));
  });

  it('keeps legacy raw offset fields mapped to normalized character offsets', async () => {
    const rawText = '\uFEFF공지\r\n\r\n제 1화 시작\r\n\r\n본문\t끝';
    const parsed = await parseNovelFile('offset.txt', toBuffer(rawText), 'utf-8');
    expect(parsed.chapters[0].rawStartOffset).toBe(0);
    expect(parsed.chapters[0].rawEndOffset).toBe(parsed.novel.normalizedText.length);
    expect(parsed.chapters[0].normalizedText).toBe('공지\n\n제 1화 시작\n\n본문  끝');
  });
});
