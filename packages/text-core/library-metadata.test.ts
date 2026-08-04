import { describe, expect, it } from 'vitest';
import { normalizeBookMetadataPatch } from './library-metadata';

describe('normalizeBookMetadataPatch', () => {
  it('normalizes optional fields, tags and decimal series indexes', () => {
    expect(
      normalizeBookMetadataPatch({
        title: '  작품  ',
        author: ' 작가 ',
        seriesIndex: 1.23456,
        tags: [' 판타지 ', '판타지', ' 성장  소설 '],
        language: 'ko-KR',
        coverPositionX: 42.444,
      }),
    ).toMatchObject({
      title: '작품',
      author: '작가',
      seriesIndex: 1.235,
      tags: ['판타지', '성장 소설'],
      language: 'ko-KR',
      coverPositionX: 42.44,
    });
  });

  it('uses null to clear optional text and rejects invalid metadata', () => {
    expect(normalizeBookMetadataPatch({ author: '  ', description: null })).toEqual({
      author: null,
      description: null,
    });
    expect(() => normalizeBookMetadataPatch({ title: ' ' })).toThrow('title is required');
    expect(() => normalizeBookMetadataPatch({ language: 'not a language tag' })).toThrow('BCP 47');
    expect(() => normalizeBookMetadataPatch({ coverPositionY: 101 })).toThrow('between 0 and 100');
  });
});
