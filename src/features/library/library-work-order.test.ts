import { describe, expect, it } from 'vitest';
import { buildLibraryBookView, type LibrarySort } from './library-screen-model';
import { orderedLibraryWorks } from './library-work-order';
import type { LibraryExternalWorkView } from './library-screen-contract';
import { testNovel } from '../book-workspace/book-workspace-test-fixtures';

const date = (day: number) => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const book = (id: string, title: string, day: number) =>
  buildLibraryBookView(testNovel({ id, title, createdAt: date(day), updatedAt: date(day), lastReadAt: date(day) }), {
    hasReadActivity: () => true,
    isFinished: () => false,
  });
const remote = (id: string, title: string, day: number): LibraryExternalWorkView => ({
  id,
  title,
  addedAt: date(day),
  updatedAt: date(day),
  lastReadAt: date(day),
  availableReleaseCount: 10,
  newReleaseCount: 0,
});
const books = [book('local-a', '나 작품', 20), book('local-b', '라 작품', 10)];
const works = [remote('stream-a', '가 작품', 25), remote('stream-b', '다 작품', 15)];

describe('mixed library sorting', () => {
  it.each<LibrarySort>(['recent', 'added', 'title'])('interleaves local and streaming works by %s', (sort) => {
    expect(orderedLibraryWorks(books, works, sort).map((item) => item.key)).toEqual([
      'external:stream-a',
      'book:local-a',
      'external:stream-b',
      'book:local-b',
    ]);
  });
  it('moves a streamed work to the top after its reading timestamp changes', () => {
    const changed = { ...works[1], lastReadAt: date(28) };
    expect(orderedLibraryWorks(books, [works[0], changed], 'recent')[0].key).toBe('external:stream-b');
    expect(orderedLibraryWorks(books, [works[0], changed], 'added')[0].key).toBe('external:stream-a');
    // A background source refresh must not override the actual reading timestamp.
    expect(
      orderedLibraryWorks(books, [{ ...changed, updatedAt: date(30), lastReadAt: date(5) }], 'recent').at(-1)?.key,
    ).toBe('external:stream-b');
  });
  it('uses the same unread fallback for both storage types and does not mutate either input', () => {
    const locals = [book('local', '가', 5)];
    locals[0].novel.lastReadAt = undefined;
    const sources = [{ ...remote('stream', '나', 10), lastReadAt: undefined }];
    const before = structuredClone({ locals, sources });
    expect(orderedLibraryWorks(locals, sources, 'recent').map((item) => item.key)).toEqual([
      'external:stream',
      'book:local',
    ]);
    expect({ locals, sources }).toEqual(before);
  });
});

it('uses the latest streamed or downloaded visit for a work that also has a local book', () => {
  const activity = new Map([['local-b', { lastReadAt: date(29) }]]);
  expect(orderedLibraryWorks(books, works, 'recent', activity)[0].key).toBe('book:local-b');
  expect(orderedLibraryWorks(books, works, 'added', activity)[0].key).toBe('external:stream-a');
  expect(orderedLibraryWorks(books, works, 'recent', new Map([['local-b', { lastReadAt: date(1) }]])).at(-1)?.key).toBe(
    'book:local-b',
  );
});
