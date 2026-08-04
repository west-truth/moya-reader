import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseNovelTextForSample } from '../domain/parser';
import { listSyncOutbox } from './sync-event-store';
import { saveImportedNovel } from './db';
import {
  applyLibraryBatch,
  createLibraryShelf,
  deleteLibraryShelf,
  listLibraryShelfMemberships,
  listLibraryShelves,
  patchLibraryBookMetadata,
  setLibraryShelfMembership,
  updateLibraryShelf,
} from './library-management-store';
import { getNovel } from './reader-query-store';
import { resetReaderDbForTests } from './reader-database';

async function book(title = '서재 테스트') {
  const parsed = await parseNovelTextForSample(title, '1화 시작\n\n본문입니다.');
  await saveImportedNovel(parsed);
  return parsed.novel.id;
}

describe('library management store', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('patches normalized metadata under a revision fence and emits a complete metadata event', async () => {
    const bookId = await book();
    const receipt = await patchLibraryBookMetadata(
      bookId,
      { author: ' 작가 ', seriesTitle: ' 시리즈 ', seriesIndex: 1.5, tags: [' 판타지 ', '판타지'] },
      0,
    );
    expect(receipt.metadataRevision).toBe(1);
    expect(await getNovel(bookId)).toMatchObject({
      author: '작가',
      seriesTitle: '시리즈',
      seriesIndex: 1.5,
      tags: ['판타지'],
      metadataRevision: 1,
    });
    const event = (await listSyncOutbox()).find((row) => row.event.type === 'book_updated')?.event;
    expect(event?.payload).toMatchObject({ novel: { id: bookId, author: '작가', metadataRevision: 1 } });
    await expect(patchLibraryBookMetadata(bookId, { language: 'ko-KR' }, 0)).rejects.toThrow('revision changed');
  });

  it('creates, reorders and deletes many-to-many shelves without deleting books', async () => {
    const bookId = await book();
    const created = await createLibraryShelf({ name: ' 읽을 책 ', color: '#AABBCC' });
    await setLibraryShelfMembership(created.shelf.id, bookId, true);
    expect(await listLibraryShelfMemberships()).toHaveLength(1);
    const updated = await updateLibraryShelf(
      created.shelf.id,
      { name: '이번 달', sortOrder: 3 },
      created.shelf.revision,
    );
    expect((await listLibraryShelves())[0]).toMatchObject({ name: '이번 달', color: '#aabbcc', sortOrder: 3 });
    await deleteLibraryShelf(created.shelf.id, updated.shelf.revision);
    expect(await listLibraryShelves()).toEqual([]);
    expect(await listLibraryShelfMemberships()).toEqual([]);
    expect(await getNovel(bookId)).toBeDefined();
  });

  it('returns stable partial batch receipts and replays by idempotency key', async () => {
    const first = await book('첫 책');
    const second = await book('둘째 책');
    const receipt = await applyLibraryBatch(
      { kind: 'add_tag', tag: '선택' },
      [
        { bookId: first, expectedRevision: 0 },
        { bookId: second, expectedRevision: 99 },
      ],
      'batch-1',
    );
    expect(receipt.results).toEqual([
      expect.objectContaining({ bookId: first, status: 'applied' }),
      expect.objectContaining({ bookId: second, status: 'failed' }),
    ]);
    expect(await applyLibraryBatch({ kind: 'set_favorite', favorite: true }, [{ bookId: first }], 'batch-1')).toEqual(
      receipt,
    );
  });
});
