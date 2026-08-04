import { describe, expect, it } from 'vitest';
import { projectSpokenText } from './spoken-text';

describe('spoken text projection', () => {
  it('normalizes Korean date, time, currency, percent and symbols with source mapping', () => {
    const result = projectSpokenText({
      text: '2026-08-01 12:30, ₩12,000 + 25%',
      language: 'ko-KR',
    });

    expect(result.spokenText).toContain('이천이십육년 팔월 일일');
    expect(result.spokenText).toContain('십이시 삼십분');
    expect(result.spokenText).toContain('일만 이천원');
    expect(result.spokenText).toContain('플러스 이십오 퍼센트');
    expect(result.spans.some((span) => span.transform === 'date' && span.sourceStart === 0)).toBe(true);
    expect(result.spans.every((span) => span.sourceEnd <= 34)).toBe(true);
  });

  it('applies pronunciation and skip rules without mutating source text', () => {
    const pronunciation = projectSpokenText({
      text: 'API 문서',
      language: 'ko',
      rules: [
        {
          id: 'api',
          scope: 'global',
          kind: 'replace_literal',
          pattern: 'API',
          replacement: '에이피아이',
          enabled: true,
          priority: 0,
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    });
    expect(pronunciation.spokenText).toBe('에이피아이 문서');
    expect(pronunciation.spans[0]).toMatchObject({ sourceStart: 0, sourceEnd: 3, transform: 'pronunciation' });

    const skipped = projectSpokenText({
      text: '[작가의 말] 다음 화에서 계속',
      rules: [
        {
          id: 'author-note',
          scope: 'book',
          bookId: 'book-1',
          kind: 'skip_prefix',
          pattern: '[작가의 말]',
          enabled: true,
          priority: 0,
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    });
    expect(skipped.spokenText).toBe('');
    expect(skipped.skipped).toEqual([{ sourceStart: 0, sourceEnd: 17, ruleId: 'author-note' }]);
  });

  it('uses ruby readings and skips EPUB footnote markers while retaining source anchors', () => {
    const result = projectSpokenText({
      text: '東京1',
      language: 'ja',
      rubyPolicy: 'reading',
      semantics: [
        { start: 0, end: 2, kind: 'ruby', value: 'とうきょう' },
        { start: 2, end: 3, kind: 'footnote_reference', value: '#note-1' },
      ],
    });

    expect(result.spokenText).toBe('とうきょう');
    expect(result.spans[0]).toMatchObject({ sourceStart: 0, sourceEnd: 2, transform: 'ruby' });
    expect(result.skipped[0]).toMatchObject({ sourceStart: 2, sourceEnd: 3, ruleId: 'epub-footnote-marker' });
  });

  it('uses conservative locale-specific date and symbol wording', () => {
    expect(projectSpokenText({ text: '2026-08-01 & 25%', language: 'en-US' }).spokenText).toBe(
      'August 1, 2026 and 25 percent',
    );
    expect(projectSpokenText({ text: '2026/08/01 + 25%', language: 'ja-JP' }).spokenText).toBe(
      '2026年08月01日 プラス 25パーセント',
    );
  });

  it('reads Korean decimals and grouped numbers without splitting the decimal fraction', () => {
    const result = projectSpokenText({
      text: '$12.50, 1,234.05, 25.5%',
      language: 'ko-KR',
    });

    expect(result.spokenText).toBe('십이 점 오 영 달러, 천이백삼십사 점 영 오, 이십오 점 오 퍼센트');
    expect(result.spans.some((span) => span.transform === 'currency' && span.sourceStart === 0)).toBe(true);
    expect(result.spans.some((span) => span.transform === 'number' && span.sourceStart === 8)).toBe(true);
  });

  it('does not label invalid calendar dates or times as valid date/time speech', () => {
    const korean = projectSpokenText({ text: '2025-02-29 25:61', language: 'ko-KR' });
    const japanese = projectSpokenText({ text: '2025-02-29 25:61', language: 'ja-JP' });
    const english = projectSpokenText({ text: '2025-02-29', language: 'en-US' });

    expect(korean.spokenText).not.toContain('년');
    expect(korean.spokenText).not.toContain('시');
    expect(japanese.spokenText).toBe('2025-02-29 25:61');
    expect(english.spokenText).toBe('2025-02-29');
  });
});
