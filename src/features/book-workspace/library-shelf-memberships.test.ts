import { expect, it } from 'vitest';
import { libraryShelfMemberships } from './library-shelf-memberships';

it('preserves a streamed shelf assignment after download and counts each local membership once', () => {
  const local = [{ bookId: 'downloaded', shelfId: 'normal' }];
  const works = [
    { id: 'stream', shelfIds: ['normal'] },
    { id: 'mixed', localBookId: 'downloaded', shelfIds: ['normal', 'other'] },
    { id: 'same-book', localBookId: 'downloaded', shelfIds: ['other'] },
    { id: 'trash', deletedAt: 'now', shelfIds: ['normal'] },
  ];
  expect(libraryShelfMemberships(local, works)).toEqual([
    { bookId: 'downloaded', shelfId: 'normal' },
    { bookId: 'external:stream', shelfId: 'normal' },
    { bookId: 'downloaded', shelfId: 'other' },
  ]);
});
