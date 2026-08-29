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
    expect(parseChapterHeading('[공장] 전체가 흔들렸다.')).toBeUndefined();
    expect(parseChapterHeading('[영화] 장면을 떠올렸다.')).toBeUndefined();
    expect(parseChapterHeading('Epilogue 1. 제로의 세계')).toEqual({
      title: 'Epilogue 1. 제로의 세계',
      family: 'numbered_special',
      number: 1,
      requiresSequence: false,
    });
  });

  it('uses repeated isolated long-form separators as document boundaries, not nearby prose', () => {
    const body = (marker: string) => `${marker} ${'장면과 대화가 충분한 길이로 계속 이어진다. '.repeat(90)}`;
    const text = [
      '제 1화 본편',
      '',
      body('본편'),
      '',
      '===',
      '',
      'Epilogue 1. 첫 번째 종장',
      '',
      body('첫 에필로그'),
      '',
      '“이제 겨우 1화 읽었는데 무슨 소리야.”',
      '',
      body('대사 뒤 본문'),
      '',
      '“나는 2부 주인공이라며.”',
      '',
      body('두 번째 대사 뒤 본문'),
      '',
      '===',
      '',
      '2부 수정본을 함께 작업하던 사람은 기지개를 켜며 다음 원고에 관해 긴 이야기를 시작했다.',
      '',
      body('둘째 에필로그'),
      '',
      '===',
      '',
      body('마지막 에필로그'),
    ].join('\n');

    const ranges = assembleChapterRanges(text, 'fixture');

    expect(ranges.map((range) => range.title)).toEqual(['제 1화 본편', 'Epilogue 1. 첫 번째 종장', '3화', '4화']);
    expect(text.slice(ranges[1]!.normalizedBodyStartOffset, ranges[1]!.normalizedBodyEndOffset)).toContain(
      '이제 겨우 1화',
    );
    expect(text.slice(ranges[2]!.normalizedBodyStartOffset, ranges[2]!.normalizedBodyEndOffset)).toContain(
      '2부 수정본',
    );
    expect(() => assertNormalizedSourceCoverage(text.length, ranges)).not.toThrow();
  });

  it('does not promote short repeated scene dividers into chapter boundaries', () => {
    const text = [
      '제 1화 시작',
      '',
      '첫 장면이다.',
      '',
      '===',
      '',
      '두 번째 장면이다.',
      '',
      '===',
      '',
      '세 번째 장면이다.',
      '',
      '===',
      '',
      '마지막 장면이다.',
    ].join('\n');

    expect(assembleChapterRanges(text, 'fixture').map((range) => range.title)).toEqual(['제 1화 시작']);
  });

  it('keeps a missing-decoration serialized part while suppressing strong-looking nested prose', () => {
    const body = (marker: string) => `${marker} ${'정상적인 연재 본문이 충분한 길이로 이어진다. '.repeat(20)}`;
    const lines: string[] = [];
    for (let part = 1; part <= 5; part += 1) {
      lines.push(part === 4 ? 'Episode 77. 연재 제목 (4)' : `< Episode 77. 연재 제목 (${part}) >`, '');
      if (part === 3) {
        lines.push(
          body('본문 속 목차'),
          '',
          'Episode 13. 과거의 장',
          '',
          'Episode 14. 다른 장',
          '',
          'Episode 15. 세 가지 방법',
          '',
          '종장. 등장인물이 마음속으로 붙인 결말의 이름.',
          '',
        );
      }
      lines.push(body(`${part}번째 본문`), '');
    }
    const text = lines.join('\n');
    const headings = resolveChapterHeadings(text);

    expect(headings).toHaveLength(5);
    expect(headings.map((heading) => heading.title)).toContain('Episode 77. 연재 제목 (4)');
    expect(headings.map((heading) => heading.title)).not.toContain('Episode 15. 세 가지 방법');
    expect(headings.map((heading) => heading.title)).not.toContain('종장. 등장인물이 마음속으로 붙인 결말의 이름.');
    const ranges = assembleChapterRanges(text, 'fixture');
    expect(text.slice(ranges[2]!.normalizedBodyStartOffset, ranges[2]!.normalizedBodyEndOffset)).toContain(
      'Episode 15. 세 가지 방법',
    );
  });

  it('uses short coherent numbered producers to reject repeated in-body catalog headings', () => {
    const body = (marker: string) => marker + ' ' + '일반적인 소설 본문이 충분한 길이로 이어진다. '.repeat(20);

    for (const style of ['angle-title', 'explicit-korean'] as const) {
      const text = Array.from({ length: 5 }, (_, index) => {
        const chapterNumber = index + 1;
        const heading = style === 'angle-title' ? '<작품 ' + chapterNumber + '화>' : '제 ' + chapterNumber + '화 실제';
        return [
          heading,
          '',
          body('앞 본문'),
          '',
          'Episode ' + (50 + index) + '. 본문 속 목차',
          '',
          body('뒤 본문'),
        ].join('\n');
      }).join('\n');

      const ranges = assembleChapterRanges(text, 'fixture');
      expect(ranges).toHaveLength(5);
      expect(ranges.every((range) => range.normalizedBodyEndOffset > range.normalizedBodyStartOffset)).toBe(true);
      expect(ranges.map((range) => range.title)).not.toContain('Episode 50. 본문 속 목차');
      expect(text.slice(ranges[0]!.normalizedBodyStartOffset, ranges[0]!.normalizedBodyEndOffset)).toContain(
        'Episode 50. 본문 속 목차',
      );
    }
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

  it('keeps a consecutive number-title format switch inside a dominant number-only run', () => {
    const body = (marker: string) => `${marker}${'가'.repeat(80)}`;
    const text = [
      '26',
      '',
      body('첫 본문 '),
      '',
      '27',
      '',
      body('둘째 본문 '),
      '',
      '28 Daydream Generation',
      '',
      body('셋째 본문 '),
      '',
      '29 가족들이 너무 많다',
      '',
      body('넷째 본문 '),
      '',
      '30',
      '',
      body('다섯째 본문 '),
      '',
      '31',
      '',
      body('여섯째 본문 '),
      '',
      '32',
      '',
      body('일곱째 본문 '),
    ].join('\n');

    expect(resolveChapterHeadings(text).map((heading) => heading.title)).toEqual([
      '26',
      '27',
      '28 Daydream Generation',
      '29 가족들이 너무 많다',
      '30',
      '31',
      '32',
    ]);
  });

  it('keeps exporter sequence headings and suppresses repeated nested episode subtitles', () => {
    const body = (marker: string) => `${marker} ${'가'.repeat(90)}`;
    const text = [
      '00001 #1 하늘산맥',
      '',
      '#1 하늘산맥',
      '',
      body('첫 번째 본문'),
      '',
      '00002 #1 하늘산맥',
      '',
      body('두 번째 본문'),
      '',
      '00003 #1 하늘산맥',
      '',
      body('세 번째 본문'),
      '',
      '00004 #2 내 이름은 유릭',
      '',
      '#2 내 이름은 유릭.',
      '',
      body('네 번째 본문'),
      '',
      '00005 #2 내 이름은 유릭',
      '',
      body('다섯 번째 본문'),
    ].join('\n');

    expect(resolveChapterHeadings(text).map((heading) => heading.title)).toEqual([
      '00001 #1 하늘산맥',
      '00002 #1 하늘산맥',
      '00003 #1 하늘산맥',
      '00004 #2 내 이름은 유릭',
      '00005 #2 내 이름은 유릭',
    ]);
  });

  it('assembles contiguous ranges while folding a prefix and empty heading into real chapters', () => {
    const text = `업로드 공지입니다.\n\n제 1화 시작\n\n첫 본문\n\n제 2화 빈 방\n\n제 3화 귀환\n\n마지막 본문`;
    const ranges = assembleChapterRanges(text, 'fixture');

    expect(ranges.map((range) => range.title)).toEqual(['제 1화 시작', '제 3화 귀환']);
    expect(ranges[0].normalizedStartOffset).toBe(0);
    expect(text.slice(ranges[0].normalizedBodyStartOffset, ranges[0].normalizedBodyEndOffset)).toContain(
      '업로드 공지입니다.',
    );
    expect(text.slice(ranges[0].normalizedBodyStartOffset, ranges[0].normalizedBodyEndOffset)).toContain(
      '제 2화 빈 방',
    );
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
