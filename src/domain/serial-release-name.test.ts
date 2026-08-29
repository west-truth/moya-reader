import { describe, expect, it } from 'vitest';
import { normalizeSerialWorkKey, parseSerialReleaseName } from './serial-release-name';

describe('serial release filename parser', () => {
  it.each([
    ['서른의 봄 12화.cbz', '서른의 봄', 'c:12', '12화'],
    ['서른의 봄 제012.5화.zip', '서른의 봄', 'c:12.5', '12.5화'],
    ['서른의 봄 12~13화.zip', '서른의 봄', 'c:12-13', '12-13화'],
    ['서른의 봄 3권.cbz', '서른의 봄', 'v:3', '3권'],
    ['서른의 봄 1권 12화.cbz', '서른의 봄', 'v:1/c:12', '1권 12화'],
    ['서른의 봄 외전 2화.cbz', '서른의 봄', 'special:extra/c:2', '외전 2화'],
    ['作品名 第2巻 第12話.zip', '作品名', 'v:2/c:12', '2권 12화'],
    ['Title Chapter 012 [Digital].cbz', 'Title', 'c:12', '12화'],
    ['Title v01 c012.zip', 'Title', 'v:1/c:12', '1권 12화'],
    ['Title S02E03.zip', 'Title', 's:2/c:3', '시즌 2 3화'],
  ])('extracts %s', (fileName, title, releaseKey, releaseTitle) => {
    expect(parseSerialReleaseName(fileName)).toMatchObject({
      workTitle: title,
      normalizedWorkKey: normalizeSerialWorkKey(title),
      releaseKey,
      releaseTitle,
      confidence: 'high',
    });
  });

  it('uses the parent package title only for a bare numeric child', () => {
    expect(parseSerialReleaseName('001.cbz', '서른의 봄.zip')).toMatchObject({
      workTitle: '서른의 봄',
      releaseKey: 'c:1',
      confidence: 'medium',
    });
    expect(parseSerialReleaseName('001.cbz')).toMatchObject({
      workTitle: '001',
      releaseKey: undefined,
      confidence: 'low',
    });
    expect(parseSerialReleaseName('서른의 봄 003.cbz', '서른의 봄')).toMatchObject({
      workTitle: '서른의 봄',
      releaseKey: 'c:3',
      confidence: 'medium',
    });
    expect(parseSerialReleaseName('서른의 봄 001-020.zip')).toMatchObject({
      workTitle: '서른의 봄',
      releaseKey: 'c:1-20',
      confidence: 'medium',
    });
  });

  it.each(['1984.cbz', '86 01.cbz', '20th Century Boys.cbz', 'Title v2 final.cbz', '2026-08-26.cbz'])(
    'does not turn an ambiguous number into a release for %s',
    (fileName) => {
      expect(parseSerialReleaseName(fileName).releaseKey).toBeUndefined();
    },
  );

  it('keeps bracketed titles unless the trailing group is recognized noise', () => {
    expect(parseSerialReleaseName('[최애의 아이] 12화 [KOR].cbz')).toMatchObject({
      workTitle: '[최애의 아이]',
      releaseKey: 'c:12',
    });
  });

  it.each([
    ['바바리안 퀘스트 1-315 完.txt', '바바리안 퀘스트', 'c:1-315', 'complete'],
    ['전지적 독자 시점 1~551화 [완결].txt', '전지적 독자 시점', 'c:1-551', 'complete'],
    ['화산귀환 총 1800화 연재중.txt', '화산귀환', undefined, 'ongoing'],
    ['[텍본] 바바리안 퀘스트 1-315 (완).txt.zip', '바바리안 퀘스트', 'c:1-315', 'complete'],
    ['1Q84 1권.epub', '1Q84', 'v:1', undefined],
    ['86 -에이티식스- 1권.epub', '86 -에이티식스', 'v:1', undefined],
  ])('extracts catalog titles from distribution-style name %s', (fileName, title, releaseKey, completion) => {
    expect(parseSerialReleaseName(fileName)).toMatchObject({
      workTitle: title,
      releaseKey,
      completion,
    });
  });

  it.each(['제5공화국.txt', '1984.txt', '2026-08-26.zip', '[최애의 아이].epub'])(
    'preserves a numeric or bracketed work title for %s',
    (fileName) => {
      const parsed = parseSerialReleaseName(fileName);
      expect(parsed.releaseKey).toBeUndefined();
      expect(parsed.workTitle).toBe(fileName.replace(/\.(?:txt|epub|zip)$/u, ''));
    },
  );

  it('keeps volume, chapter and special namespaces distinct', () => {
    expect(parseSerialReleaseName('작품 1권.cbz').releaseKey).not.toBe(
      parseSerialReleaseName('작품 1화.cbz').releaseKey,
    );
    expect(parseSerialReleaseName('작품 외전 1화.cbz').releaseKey).not.toBe(
      parseSerialReleaseName('작품 1화.cbz').releaseKey,
    );
  });
});
