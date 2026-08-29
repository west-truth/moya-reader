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
      totalChapters: 2,
      totalCharacters: 48,
      totalParagraphs: 5,
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
        'chapter_bb2cd544d6bf9886a514b1c10aa011aa',
        '제 1화 시작',
        '공지\n\n제 1화 시작\n\n첫 문단\n둘째 줄\n\n제 2화 빈 방',
        'sha256:8c68abae4d6a7566fce38f21c3922bfc8bfe3c720ef819440ac94f76eae01537',
        0,
        34,
        32,
        4,
      ],
      [
        'chapter_59f79b1c96b1880aaadafd2658fc70c2',
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
        'paragraph_fe9e9d2865cb859e86152a5c00417a29',
        'chapter_bb2cd544d6bf9886a514b1c10aa011aa',
        1,
        '공지',
        0,
        2,
        'sha256:b6412a92e8c6393c1018fd269a9d07e33c61ee394c45f4e43ab9b7f17ee84469',
      ],
      [
        'paragraph_8b3d4d767a13e5df9c236a167a8b48d4',
        'chapter_bb2cd544d6bf9886a514b1c10aa011aa',
        2,
        '제 1화 시작',
        4,
        11,
        'sha256:816d790a61a204072da4de44cbf6ff023cb84ba93f5b6332bcf9a1292cb4abb6',
      ],
      [
        'paragraph_9784618bf22b26f3d24c8e8f1fc63be5',
        'chapter_bb2cd544d6bf9886a514b1c10aa011aa',
        3,
        '첫 문단\n둘째 줄',
        13,
        22,
        'sha256:5993586473aec611fa79b410e8e387111680b467204839e22efecf67469b6bc7',
      ],
      [
        'paragraph_7b2655e329a345d01cdf560f1a5bfaba',
        'chapter_bb2cd544d6bf9886a514b1c10aa011aa',
        4,
        '제 2화 빈 방',
        24,
        32,
        'sha256:24d1af0be0e4460c5f0d811030c7121c51758d2ea8df9c0161387a42c790438c',
      ],
      [
        'paragraph_016005efd568e9d217239fb3c48c054f',
        'chapter_59f79b1c96b1880aaadafd2658fc70c2',
        1,
        '마지막 문단',
        0,
        6,
        'sha256:661298fdc642cfb83b5fd7c307e245f14bffccc62ddcd80c6ba76b9c309af20e',
      ],
    ]);
  });
});
