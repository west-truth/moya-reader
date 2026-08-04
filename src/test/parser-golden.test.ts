import { describe, expect, it } from 'vitest';
import { parseNovelFile } from '../domain/parser';

function toBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe('parser golden output', () => {
  it('preserves IDs, hashes, normalized coverage offsets, and paragraph offsets', async () => {
    const source = `공지

제 1화 시작

첫 문단
둘째 줄

제 2화 빈 방

제 3화 끝

마지막 문단`;
    const parsed = await parseNovelFile('golden.txt', toBuffer(source), 'utf-8');

    expect({
      id: parsed.novel.id,
      rawTextHash: parsed.novel.rawTextHash,
      normalizedTextHash: parsed.novel.normalizedTextHash,
      coverSeed: parsed.novel.coverSeed,
      totalChapters: parsed.novel.totalChapters,
      totalCharacters: parsed.novel.totalCharacters,
      totalParagraphs: parsed.novel.totalParagraphs,
    }).toEqual({
      id: 'novel_17e3ee8ef1c9ebe110f3c833e17b71c9',
      rawTextHash: 'sha256:d3b33f5bfaa6fd484d58c45b8b5666472b5bbccdfe5fbfc6dcffe6b80b256ba1',
      normalizedTextHash: 'sha256:d3b33f5bfaa6fd484d58c45b8b5666472b5bbccdfe5fbfc6dcffe6b80b256ba1',
      coverSeed: 6428,
      totalChapters: 4,
      totalCharacters: 48,
      totalParagraphs: 4,
    });

    expect(
      parsed.chapters.map((chapter) => [
        chapter.id,
        chapter.title,
        chapter.normalizedText,
        chapter.textHash,
        chapter.rawStartOffset,
        chapter.rawEndOffset,
        chapter.characterCount,
        chapter.paragraphCount,
      ]),
    ).toEqual([
      [
        'chapter_7eedfcd2f77a6c7ff8cb12bada3c8c0d',
        '머리말',
        '공지',
        'sha256:b6412a92e8c6393c1018fd269a9d07e33c61ee394c45f4e43ab9b7f17ee84469',
        0,
        4,
        2,
        1,
      ],
      [
        'chapter_e2b1ce37695acbaff0dafbd8909d39e7',
        '제 1화 시작',
        '첫 문단\n둘째 줄',
        'sha256:5993586473aec611fa79b410e8e387111680b467204839e22efecf67469b6bc7',
        4,
        24,
        9,
        2,
      ],
      [
        'chapter_c77aaba899236b21da84c32eed15caf8',
        '제 2화 빈 방',
        '',
        'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        24,
        34,
        0,
        0,
      ],
      [
        'chapter_a7a09a1bf456ab4a5be01bac7db8e519',
        '제 3화 끝',
        '마지막 문단',
        'sha256:661298fdc642cfb83b5fd7c307e245f14bffccc62ddcd80c6ba76b9c309af20e',
        34,
        48,
        6,
        1,
      ],
    ]);

    expect(
      parsed.paragraphs.map((paragraph) => [
        paragraph.id,
        paragraph.chapterId,
        paragraph.index,
        paragraph.text,
        paragraph.startOffsetInChapter,
        paragraph.endOffsetInChapter,
        paragraph.textHash,
      ]),
    ).toEqual([
      [
        'paragraph_be45a2336d08e0bfaa61240ea54c830c',
        'chapter_7eedfcd2f77a6c7ff8cb12bada3c8c0d',
        1,
        '공지',
        0,
        2,
        'sha256:b6412a92e8c6393c1018fd269a9d07e33c61ee394c45f4e43ab9b7f17ee84469',
      ],
      [
        'paragraph_bb62328a15048705b168f2d3a035243c',
        'chapter_e2b1ce37695acbaff0dafbd8909d39e7',
        1,
        '첫 문단',
        0,
        4,
        'sha256:08ec5087dfd5d57ef9d2524342bf49ab9ad897c57b67c3cb87d1358508e31bed',
      ],
      [
        'paragraph_8cec809ee65a53fc00bbf9687d50dd89',
        'chapter_e2b1ce37695acbaff0dafbd8909d39e7',
        2,
        '둘째 줄',
        5,
        9,
        'sha256:c6572d768c5b461534d384d4ff9ea8a861f859622d4edab91a7745bd23bd12c9',
      ],
      [
        'paragraph_c8b7dfd62562c911d6d1e5c9b6529c9e',
        'chapter_a7a09a1bf456ab4a5be01bac7db8e519',
        1,
        '마지막 문단',
        0,
        6,
        'sha256:661298fdc642cfb83b5fd7c307e245f14bffccc62ddcd80c6ba76b9c309af20e',
      ],
    ]);
  });
});
