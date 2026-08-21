import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReaderPageBoundary } from '../domain/types';
import { openReaderDb, resetReaderDbForTests } from './reader-database';
import {
  loadReaderPageMap,
  pruneReaderPageMaps,
  readerPageMapId,
  saveReaderPageMap,
  type ReaderPageMapIdentity,
} from './reader-page-map-store';
import { READER_PAGE_MAP_STORE } from './reader-page-map-schema';

const identity = (chapterId: string): ReaderPageMapIdentity => ({
  chapterId,
  contentRevisionId: 'revision-1',
  layoutKey: '{"width":800}',
  rendererVersion: 'reader-pagination-v3-sentence-safe-area',
});

const boundary: ReaderPageBoundary = {
  index: 0,
  start: {
    bookId: 'book-1',
    contentRevisionId: 'revision-1',
    sectionId: 'chapter-1',
    blockId: 'paragraph-1',
    blockIndex: 0,
    offset: 0,
  },
  end: {
    bookId: 'book-1',
    contentRevisionId: 'revision-1',
    sectionId: 'chapter-1',
    blockId: 'paragraph-2',
    blockIndex: 1,
    offset: 4,
  },
};

describe('reader page map store', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('creates the local-only page map store and restores an exact layout identity', async () => {
    const db = await openReaderDb();
    expect(db.objectStoreNames.contains(READER_PAGE_MAP_STORE)).toBe(true);

    await saveReaderPageMap(identity('chapter-1'), [boundary], '2026-08-21T00:00:00.000Z');
    const restored = await loadReaderPageMap(identity('chapter-1'), '2026-08-21T00:01:00.000Z');

    expect(restored?.id).toBe(readerPageMapId(identity('chapter-1')));
    expect(restored?.boundaries).toEqual([boundary]);
    expect(restored?.lastAccessedAt).toBe('2026-08-21T00:01:00.000Z');
    expect(await loadReaderPageMap({ ...identity('chapter-1'), layoutKey: '{"width":600}' })).toBeUndefined();
  });

  it('prunes the least recently used layouts', async () => {
    await saveReaderPageMap(identity('chapter-1'), [boundary], '2026-08-21T00:00:00.000Z');
    await saveReaderPageMap(identity('chapter-2'), [boundary], '2026-08-21T00:01:00.000Z');
    await saveReaderPageMap(identity('chapter-3'), [boundary], '2026-08-21T00:02:00.000Z');

    expect(await pruneReaderPageMaps(2)).toBe(1);
    expect(await loadReaderPageMap(identity('chapter-1'))).toBeUndefined();
    expect(await loadReaderPageMap(identity('chapter-2'))).toBeDefined();
    expect(await loadReaderPageMap(identity('chapter-3'))).toBeDefined();
  });
});
