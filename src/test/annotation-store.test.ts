import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { bookmarkRevision, ResourceRevisionConflictError } from '../domain/resource-revisions';
import type { Bookmark, ReaderHighlight, ReaderNote } from '../domain/types';
import * as annotationStore from '../storage/annotation-store';
import * as readerDb from '../storage/db';

describe('annotation store', () => {
  beforeEach(async () => {
    await readerDb.resetReaderDbForTests();
  });

  it('keeps the db compatibility facade bound to the annotation module', () => {
    expect(readerDb.getBookmarks).toBe(annotationStore.getBookmarks);
    expect(readerDb.saveHighlight).toBe(annotationStore.saveHighlight);
    expect(readerDb.deleteNote).toBe(annotationStore.deleteNote);
  });

  it('sorts indexed annotation reads and records create, update, and tombstone events', async () => {
    const bookmark: Bookmark = {
      id: 'annotation-bookmark',
      novelId: 'annotation-book',
      chapterId: 'annotation-chapter',
      label: 'Bookmark',
      progress: 0.2,
      scrollTop: 10,
      createdAt: '2026-07-10T00:01:00.000Z',
    };
    const newerBookmark: Bookmark = {
      ...bookmark,
      id: 'annotation-bookmark-newer',
      createdAt: '2026-07-10T00:02:00.000Z',
    };
    const highlight: ReaderHighlight = {
      id: 'annotation-highlight',
      novelId: 'annotation-book',
      chapterId: 'annotation-chapter',
      paragraphId: 'annotation-paragraph',
      quote: 'Quote',
      color: 'green',
      progress: 0.3,
      createdAt: '2026-07-10T00:03:00.000Z',
      updatedAt: '2026-07-10T00:03:00.000Z',
    };
    const note: ReaderNote = {
      id: 'annotation-note',
      novelId: 'annotation-book',
      chapterId: 'annotation-chapter',
      body: 'First',
      progress: 0.4,
      createdAt: '2026-07-10T00:04:00.000Z',
      updatedAt: '2026-07-10T00:04:00.000Z',
    };

    await annotationStore.saveBookmark(bookmark);
    await annotationStore.saveBookmark(newerBookmark);
    await annotationStore.saveHighlight(highlight);
    await annotationStore.saveNote(note);
    await annotationStore.saveNote({ ...note, body: 'Updated', updatedAt: '2026-07-10T00:05:00.000Z' });

    expect((await annotationStore.getBookmarks('annotation-book')).map((item) => item.id)).toEqual([
      'annotation-bookmark-newer',
      'annotation-bookmark',
    ]);
    expect(await annotationStore.getHighlights('annotation-book')).toEqual([highlight]);
    expect(await annotationStore.getNotes('annotation-book')).toEqual([
      expect.objectContaining({ id: 'annotation-note', body: 'Updated' }),
    ]);

    await annotationStore.deleteBookmark(bookmark.id);
    await annotationStore.deleteHighlight(highlight.id);
    await annotationStore.deleteNote(note.id);

    expect((await readerDb.listSyncOutbox()).map((item) => item.event.type)).toEqual([
      'bookmark_created',
      'bookmark_created',
      'highlight_created',
      'note_created',
      'note_updated',
      'bookmark_deleted',
      'highlight_deleted',
      'note_deleted',
    ]);
    const db = await readerDb.openReaderDb();
    const tx = db.transaction('sync_tombstones', 'readonly');
    expect(
      await new Promise<number>((resolve, reject) => {
        const request = tx.objectStore('sync_tombstones').count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
    ).toBe(3);
  });

  it('rejects stale entity updates and deletes without changing the annotation or outbox', async () => {
    const bookmark: Bookmark = {
      id: 'revision-bookmark',
      novelId: 'revision-book',
      chapterId: 'revision-chapter',
      label: 'Original',
      progress: 0.25,
      scrollTop: 25,
      createdAt: '2026-07-10T01:00:00.000Z',
    };
    await annotationStore.saveBookmark(bookmark, { expectedRevision: bookmarkRevision() });

    const initialRevision = bookmarkRevision(bookmark);
    const updated = { ...bookmark, label: 'Updated', progress: 0.5 };
    await annotationStore.saveBookmark(updated, { expectedRevision: initialRevision });
    const outboxAfterUpdate = await readerDb.listSyncOutbox();

    await expect(
      annotationStore.saveBookmark({ ...bookmark, label: 'Stale update' }, { expectedRevision: initialRevision }),
    ).rejects.toBeInstanceOf(ResourceRevisionConflictError);
    await expect(
      annotationStore.deleteBookmark(bookmark.id, { expectedRevision: initialRevision }),
    ).rejects.toBeInstanceOf(ResourceRevisionConflictError);

    expect(await annotationStore.getBookmarks(bookmark.novelId)).toEqual([updated]);
    expect(await readerDb.listSyncOutbox()).toEqual(outboxAfterUpdate);
  });
});
