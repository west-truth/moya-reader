import { describe, expect, it } from 'vitest';
import { assembleChapterRanges, assertNormalizedSourceCoverage } from '../domain/parser/chapter-range-assembler';
import { decodeNovelTextWithEncoding } from '../domain/parser/encoding';
import { parseChapterHeading } from '../domain/parser/heading-detector';
import { resolveChapterHeadings } from '../domain/parser/heading-sequence-resolver';
import { normalizeNovelText, trimNormalizedTextRange } from '../domain/parser/normalization';
import { countParagraphsInRange, iterateParagraphsInRange } from '../domain/parser/paragraph-builder';

function toBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe('parser modules', () => {
  it('decodes file bytes without depending on parser orchestration', () => {
    expect(decodeNovelTextWithEncoding(toBuffer('제 1화 시작'), 'auto')).toEqual({
      text: '제 1화 시작',
      encoding: 'utf-8',
    });

    const eucKr = Uint8Array.from([0xc7, 0xd1, 0xb1, 0xdb, 0x20, 0xba, 0xbb, 0xb9, 0xae]).buffer;
    expect(decodeNovelTextWithEncoding(eucKr, 'euc-kr')).toEqual({
      text: '한글 본문',
      encoding: 'euc-kr',
    });
  });

  it('normalizes source text and trims ranges without rewriting their contents', () => {
    const normalized = normalizeNovelText('\uFEFF  첫 줄\r\n둘째 줄  \r\n\r\n끝\t');
    const range = trimNormalizedTextRange(`xx  ${normalized}  yy`, 2, normalized.length + 6);

    expect(normalized).toBe('첫 줄\n둘째 줄\n\n끝');
    expect(range).toEqual({ start: 4, end: normalized.length + 4 });
  });

  it('detects regex families and leaves weak headings for sequence resolution', () => {
    expect(parseChapterHeading('제 십이화 선택')).toEqual({
      title: '제 십이화 선택',
      family: 'je_hwa_jang',
      number: 12,
      requiresSequence: false,
    });
    expect(parseChapterHeading('[002]')).toEqual({
      title: '[002]',
      family: 'bracket_number',
      number: 2,
      requiresSequence: true,
    });
    expect(parseChapterHeading('<[002]>')).toEqual({
      title: '[002]',
      family: 'angle_bracket_number',
      number: 2,
      requiresSequence: false,
    });
    expect(parseChapterHeading('52 Lack of time')).toEqual({
      title: '52 Lack of time',
      family: 'number_title',
      number: 52,
      requiresSequence: true,
    });
    expect(parseChapterHeading('[시스템 알림: 선택지가 열렸습니다.]')).toBeUndefined();
  });

  it('keeps the exact weak-sequence body threshold', () => {
    const accepted = `1. First\n\n${'a'.repeat(40)}\n\n2. Second\n\n${'b'.repeat(40)}`;
    const rejected = `1. First\n\n${'a'.repeat(39)}\n\n2. Second\n\n${'b'.repeat(40)}`;

    expect(resolveChapterHeadings(accepted).map((heading) => heading.title)).toEqual(['1. First', '2. Second']);
    expect(resolveChapterHeadings(rejected)).toEqual([]);
    expect(resolveChapterHeadings(accepted, { mode: 'single' })).toEqual([]);
  });

  it('resolves mixed number-only and number-title headings as one anchored sequence', () => {
    const body = (marker: string) => `${marker}${'가'.repeat(80)}`;
    const text = [
      '01 첫 번째 장',
      '',
      body('첫 본문 '),
      '',
      '02',
      '',
      body('둘째 본문 '),
      '',
      '03',
      '',
      body('셋째 본문 '),
      '',
      '04 Fourth chapter',
      '',
      body('넷째 본문 '),
      '',
      '05',
      '',
      body('다섯째 본문 '),
      '',
      '06',
      '',
      body('여섯째 본문 '),
    ].join('\n');

    expect(resolveChapterHeadings(text).map((heading) => heading.title)).toEqual([
      '01 첫 번째 장',
      '02',
      '03',
      '04 Fourth chapter',
      '05',
      '06',
    ]);
  });

  it('assembles contiguous chapter ranges while retaining prefix and empty-heading coverage', () => {
    const text = `업로드 공지입니다.\n\n제 1화 시작\n\n첫 본문\n\n제 2화 빈 방\n\n제 3화 귀환\n\n마지막 본문`;
    const ranges = assembleChapterRanges(text, 'fixture');

    expect(ranges.map((range) => range.title)).toEqual(['머리말', '제 1화 시작', '제 2화 빈 방', '제 3화 귀환']);
    expect(ranges[2].normalizedBodyStartOffset).toBe(ranges[2].normalizedBodyEndOffset);
    expect(ranges[0].normalizedStartOffset).toBe(0);
    expect(ranges.at(-1)?.normalizedEndOffset).toBe(text.length);
    ranges.slice(1).forEach((range, index) => {
      expect(range.normalizedStartOffset).toBe(ranges[index].normalizedEndOffset);
    });
    expect(() => assertNormalizedSourceCoverage(text.length, ranges)).not.toThrow();
  });

  it('rejects chapter range gaps independently of chapter parsing', () => {
    expect(() =>
      assertNormalizedSourceCoverage(10, [
        {
          title: 'gap',
          normalizedStartOffset: 1,
          normalizedEndOffset: 10,
          normalizedBodyStartOffset: 1,
          normalizedBodyEndOffset: 10,
        },
      ]),
    ).toThrow('overlapping or incomplete normalized source ranges');
  });

  it('builds paragraphs and chapter-relative offsets from a bounded source range', () => {
    const sourceText = 'xx  alpha  \n\nbeta\nline\n\n gamma  yy';
    const start = 2;
    const end = sourceText.length - 2;
    const paragraphs = Array.from(iterateParagraphsInRange('novel', 'chapter', sourceText, start, end));

    expect(countParagraphsInRange(sourceText, start, end)).toBe(3);
    expect(paragraphs.map((paragraph) => paragraph.text)).toEqual(['alpha', 'beta\nline', 'gamma']);
    for (const paragraph of paragraphs) {
      expect(sourceText.slice(start + paragraph.startOffsetInChapter, start + paragraph.endOffsetInChapter)).toBe(
        paragraph.text,
      );
    }
  });
});
