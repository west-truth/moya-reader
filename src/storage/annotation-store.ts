import type { Bookmark, ReaderHighlight, ReaderNote } from '../domain/types';
import {
  assertResourceRevision,
  bookmarkRevision,
  highlightRevision,
  noteRevision,
  type ResourceMutationOptions,
} from '../domain/resource-revisions';
import { getAllByIndex, requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';
import { jsonValue, nowIso, queueSyncEventInTransaction, tombstoneEntity, tombstoneId } from './sync-event-store';

export async function getBookmarks(novelId: string): Promise<Bookmark[]> {
  const bookmarks = await getAllByIndex<Bookmark>('bookmarks', 'novelId', novelId);
  return bookmarks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveBookmark(bookmark: Bookmark, options?: ResourceMutationOptions): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(['bookmarks', 'sync_tombstones', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const current = await requestToPromise<Bookmark | undefined>(tx.objectStore('bookmarks').get(bookmark.id));
  if (options) assertResourceRevision('bookmark', options.expectedRevision, bookmarkRevision(current));
  tx.objectStore('sync_tombstones').delete(tombstoneId('bookmark', bookmark.id));
  tx.objectStore('bookmarks').put(bookmark);
  await queueSyncEventInTransaction(tx, 'bookmark_created', jsonValue({ bookmark }), {
    novelId: bookmark.novelId,
    entityId: bookmark.id,
  });
  await transactionDone(tx);
}

export async function deleteBookmark(id: string, options?: ResourceMutationOptions): Promise<void> {
  const deletedAt = nowIso();
  const db = await openReaderDb();
  const tx = db.transaction(['bookmarks', 'sync_tombstones', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const bookmark = await requestToPromise<Bookmark | undefined>(tx.objectStore('bookmarks').get(id));
  if (options) assertResourceRevision('bookmark', options.expectedRevision, bookmarkRevision(bookmark));
  tx.objectStore('bookmarks').delete(id);
  tx.objectStore('sync_tombstones').put(tombstoneEntity('bookmark', id, deletedAt, bookmark?.novelId));
  await queueSyncEventInTransaction(tx, 'bookmark_deleted', jsonValue({ id, bookmark, deletedAt }), {
    novelId: bookmark?.novelId,
    entityId: id,
  });
  await transactionDone(tx);
}

export async function getHighlights(novelId: string): Promise<ReaderHighlight[]> {
  const highlights = await getAllByIndex<ReaderHighlight>('highlights', 'novelId', novelId);
  return highlights.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveHighlight(highlight: ReaderHighlight, options?: ResourceMutationOptions): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(['highlights', 'sync_tombstones', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const current = await requestToPromise<ReaderHighlight | undefined>(tx.objectStore('highlights').get(highlight.id));
  if (options) assertResourceRevision('highlight', options.expectedRevision, highlightRevision(current));
  tx.objectStore('sync_tombstones').delete(tombstoneId('highlight', highlight.id));
  tx.objectStore('highlights').put(highlight);
  await queueSyncEventInTransaction(tx, 'highlight_created', jsonValue({ highlight }), {
    novelId: highlight.novelId,
    entityId: highlight.id,
  });
  await transactionDone(tx);
}

export async function deleteHighlight(id: string, options?: ResourceMutationOptions): Promise<void> {
  const deletedAt = nowIso();
  const db = await openReaderDb();
  const tx = db.transaction(['highlights', 'sync_tombstones', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const highlight = await requestToPromise<ReaderHighlight | undefined>(tx.objectStore('highlights').get(id));
  if (options) assertResourceRevision('highlight', options.expectedRevision, highlightRevision(highlight));
  tx.objectStore('highlights').delete(id);
  tx.objectStore('sync_tombstones').put(tombstoneEntity('highlight', id, deletedAt, highlight?.novelId));
  await queueSyncEventInTransaction(tx, 'highlight_deleted', jsonValue({ id, highlight, deletedAt }), {
    novelId: highlight?.novelId,
    entityId: id,
  });
  await transactionDone(tx);
}

export async function getNotes(novelId: string): Promise<ReaderNote[]> {
  const notes = await getAllByIndex<ReaderNote>('notes', 'novelId', novelId);
  return notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveNote(note: ReaderNote, options?: ResourceMutationOptions): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(['notes', 'sync_tombstones', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const existing = await requestToPromise<ReaderNote | undefined>(tx.objectStore('notes').get(note.id));
  if (options) assertResourceRevision('note', options.expectedRevision, noteRevision(existing));
  tx.objectStore('sync_tombstones').delete(tombstoneId('note', note.id));
  tx.objectStore('notes').put(note);
  await queueSyncEventInTransaction(tx, existing ? 'note_updated' : 'note_created', jsonValue({ note }), {
    novelId: note.novelId,
    entityId: note.id,
  });
  await transactionDone(tx);
}

export async function deleteNote(id: string, options?: ResourceMutationOptions): Promise<void> {
  const deletedAt = nowIso();
  const db = await openReaderDb();
  const tx = db.transaction(['notes', 'sync_tombstones', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const note = await requestToPromise<ReaderNote | undefined>(tx.objectStore('notes').get(id));
  if (options) assertResourceRevision('note', options.expectedRevision, noteRevision(note));
  tx.objectStore('notes').delete(id);
  tx.objectStore('sync_tombstones').put(tombstoneEntity('note', id, deletedAt, note?.novelId));
  await queueSyncEventInTransaction(tx, 'note_deleted', jsonValue({ id, note, deletedAt }), {
    novelId: note?.novelId,
    entityId: id,
  });
  await transactionDone(tx);
}
