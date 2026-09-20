import { describe, expect, it } from 'vitest';
import type { Chapter, Novel } from '../../domain/types';
import { retentionCandidates } from './download-retention';

const novel = { id: 'book', activeContentRevisionId: 'revision', lastReadChapterId: 'c8' } as Novel;
const chapters = Array.from(
  { length: 8 },
  (_, n) =>
    ({ id: `c${n + 1}`, index: n, documentSectionId: `s${n + 1}`, documentSectionReadAt: '2026-09-20' }) as Chapter,
);
describe('read download retention', () => {
  it('counts completed sections, not pages, and keeps the recent five and resume section', () => {
    expect(retentionCandidates(novel, chapters, 5)).toEqual(['s1', 's2', 's3']);
    expect(retentionCandidates({ ...novel, lastReadChapterId: 'c1' }, chapters, 5)).toEqual(['s2', 's3']);
    expect(retentionCandidates(novel, [...chapters, { ...chapters[0]!, id: 'page2' }], 5)).toEqual(['s1', 's2', 's3']);
  });
  it('never treats skipped chapters as read and protects favorite or deleted books', () => {
    const skipped = chapters.map((c, n) => (n < 2 ? { ...c, documentSectionReadAt: undefined } : c));
    expect(retentionCandidates(novel, skipped, 5)).toEqual(['s3']);
    expect(retentionCandidates({ ...novel, favorite: true }, chapters, 5)).toEqual([]);
    expect(retentionCandidates({ ...novel, deletedAt: '2026-09-20' }, chapters, 5)).toEqual([]);
    expect(retentionCandidates(novel, chapters, 10)).toEqual([]);
  });
});
