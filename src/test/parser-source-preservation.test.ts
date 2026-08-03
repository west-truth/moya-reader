import { describe, expect, it } from 'vitest';
import { normalizeNovelText, parseNovelFile, parseNovelFileForImport } from '../domain/parser';
import type { Chapter, Paragraph, ParsedNovelImportChapterSource } from '../domain/types';

function toBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function withoutParserWhitespace(text: string): string {
  return text.replace(/\s/g, '');
}

async function collectImportParagraphs(source: ParsedNovelImportChapterSource): Promise<Paragraph[]> {
  const paragraphs: Paragraph[] = [];
  for await (const item of source) paragraphs.push(...item.paragraphs);
  return paragraphs;
}

function expectNormalizedSourceCoverage(chapters: Chapter[], paragraphs: Paragraph[], normalizedText: string): void {
  expect(chapters.length).toBeGreaterThan(0);

  let nextNormalizedOffset = 0;
  const resultText: string[] = [];
  for (const chapter of chapters) {
    expect(chapter.rawStartOffset).toBe(nextNormalizedOffset);
    expect(chapter.rawEndOffset).toBeGreaterThanOrEqual(chapter.rawStartOffset);
    nextNormalizedOffset = chapter.rawEndOffset;

    if (chapter.title !== '머리말') resultText.push(chapter.title);
    resultText.push(
      ...paragraphs.filter((paragraph) => paragraph.chapterId === chapter.id).map((paragraph) => paragraph.text),
    );
  }

  expect(nextNormalizedOffset).toBe(normalizedText.length);
  expect(withoutParserWhitespace(resultText.join('\n'))).toBe(withoutParserWhitespace(normalizedText));
}

describe('novel parser source preservation', () => {
  it('preserves a short prefix before the first heading as a preface chapter', async () => {
    const parsed = await parseNovelFile(
      '짧은 머리말.txt',
      toBuffer(`업로드 공지: 맞춤법 교정본입니다.

제 1화 시작

첫 번째 본문은 독자가 원문 보존 여부를 확인할 수 있도록 충분한 내용을 담고 있다.`),
      'utf-8',
    );

    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['머리말', '제 1화 시작']);
    expect(parsed.chapters[0]).toMatchObject({
      normalizedText: '업로드 공지: 맞춤법 교정본입니다.',
      paragraphCount: 1,
    });
    expectNormalizedSourceCoverage(parsed.chapters, parsed.paragraphs, parsed.novel.normalizedText);
  });

  it('preserves an empty heading as chapter metadata without inventing body text', async () => {
    const parsed = await parseNovelFile(
      '빈 화.txt',
      toBuffer(`제 1화 시작

첫 번째 화의 본문이다.

제 2화 비어 있는 방

제 3화 귀환

세 번째 화의 본문이다.`),
      'utf-8',
    );

    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual([
      '제 1화 시작',
      '제 2화 비어 있는 방',
      '제 3화 귀환',
    ]);
    expect(parsed.chapters[1]).toMatchObject({ normalizedText: '', characterCount: 0, paragraphCount: 0 });
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

  it('preserves prefix and empty-heading content in the one-shot import result', async () => {
    const source = `개정판 업로드 공지입니다.

제 1화 시작

첫 번째 화의 본문이다.

제 2화 비어 있는 방

제 3화 귀환

세 번째 화의 본문이다.`;
    const parsed = await parseNovelFileForImport('가져오기 보존.txt', toBuffer(source), 'utf-8');
    const paragraphs = await collectImportParagraphs(parsed.consumeChapterParagraphs());

    expect(parsed.novel).toMatchObject({ rawText: '', normalizedText: '' });
    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual([
      '머리말',
      '제 1화 시작',
      '제 2화 비어 있는 방',
      '제 3화 귀환',
    ]);
    expect(parsed.chapters[2]).toMatchObject({ characterCount: 0, paragraphCount: 0 });
    expectNormalizedSourceCoverage(parsed.chapters, paragraphs, normalizeNovelText(source));
  });

  it('keeps legacy raw offset fields mapped to normalized character offsets', async () => {
    const rawText = '\uFEFF공지\r\n\r\n제 1화 시작\r\n\r\n본문\t끝';
    const parsed = await parseNovelFile('offset.txt', toBuffer(rawText), 'utf-8');
    const headingOffset = parsed.novel.normalizedText.indexOf('제 1화 시작');

    expect(parsed.chapters[1].rawStartOffset).toBe(headingOffset);
    expect(parsed.chapters[1].rawStartOffset).not.toBe(rawText.indexOf('제 1화 시작'));
    expect(parsed.novel.normalizedText.slice(parsed.chapters[1].rawStartOffset)).toBe('제 1화 시작\n\n본문  끝');
  });
});
