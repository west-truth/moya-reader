import 'fake-indexeddb/auto';
import type { DocumentAnnotation } from '../domain/types';
import type { SyncEvent } from '../sync/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAllRecords } from './indexeddb-transaction';
import { resetReaderDbForTests } from './reader-database';
import { applyRemoteSyncEvents } from './db';
import { IndexedDbDocumentAnnotationRepository } from './document-annotation-store';
import { jsonValue, listSyncOutbox, type SyncTombstone } from './sync-event-store';

const annotation: DocumentAnnotation = {
  id: 'annotation-1',
  bookId: 'book',
  pageIndex: 3,
  type: 'text_highlight',
  anchor: {
    kind: 'fixed_text',
    bookId: 'book',
    pageIndex: 3,
    textRevisionId: 'revision',
    blockId: 'block',
    startOffset: 2,
    endOffset: 8,
    quads: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }],
  },
  quote: '문장 일부',
  color: 'yellow',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

describe('IndexedDbDocumentAnnotationRepository', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('lists page annotations and retains a tombstone instead of deleting user history', async () => {
    const repository = new IndexedDbDocumentAnnotationRepository();
    await repository.save(annotation);
    expect(await repository.listPage('book', 3)).toEqual([annotation]);
    await repository.remove(annotation.id, '2026-08-01T00:01:00.000Z');
    expect(await repository.list('book')).toEqual([]);
    expect(await repository.listPage('book', 3)).toEqual([]);
    expect(await getAllRecords<SyncTombstone>('sync_tombstones')).toEqual([
      expect.objectContaining({
        id: 'document_annotation:annotation-1',
        entityType: 'document_annotation',
        entityId: annotation.id,
        novelId: annotation.bookId,
        deletedAt: '2026-08-01T00:01:00.000Z',
      }),
    ]);

    await repository.save({ ...annotation, body: 'restored', updatedAt: '2026-08-01T00:02:00.000Z' });
    expect(await getAllRecords<SyncTombstone>('sync_tombstones')).toEqual([]);
    expect(await repository.listPage('book', 3)).toEqual([
      { ...annotation, body: 'restored', updatedAt: '2026-08-01T00:02:00.000Z', deletedAt: undefined },
    ]);
    expect((await listSyncOutbox()).map((item) => item.event.type)).toEqual([
      'document_annotation_updated',
      'document_annotation_deleted',
      'document_annotation_updated',
    ]);
  });

  it('applies only newer remote annotation updates and deletion events', async () => {
    const repository = new IndexedDbDocumentAnnotationRepository();
    const updatedAt = '2026-08-01T00:03:00.000Z';
    const remote = { ...annotation, body: 'remote', updatedAt };
    const event = (type: SyncEvent['type'], payload: unknown, createdAt: string): SyncEvent => ({
      id: `event-${type}-${createdAt}`,
      type,
      deviceId: 'remote-device',
      novelId: annotation.bookId,
      entityId: annotation.id,
      payload: jsonValue(payload),
      createdAt,
    });

    await applyRemoteSyncEvents([
      event('document_annotation_updated', { annotation: remote }, updatedAt),
      event('document_annotation_deleted', { id: annotation.id, deletedAt: '2026-08-01T00:02:00.000Z' }, updatedAt),
    ]);
    expect(await repository.listPage(annotation.bookId, annotation.pageIndex)).toEqual([remote]);

    const deletedAt = '2026-08-01T00:04:00.000Z';
    await applyRemoteSyncEvents([event('document_annotation_deleted', { id: annotation.id, deletedAt }, deletedAt)]);
    expect(await repository.list(annotation.bookId)).toEqual([]);
    expect(await getAllRecords<SyncTombstone>('sync_tombstones')).toEqual([
      expect.objectContaining({ entityType: 'document_annotation', entityId: annotation.id, deletedAt }),
    ]);
  });

  it('persists normalized fixed-region highlights without changing the source page', async () => {
    const repository = new IndexedDbDocumentAnnotationRepository();
    const region: DocumentAnnotation = {
      ...annotation,
      id: 'annotation-region',
      type: 'region_highlight',
      quote: undefined,
      anchor: {
        kind: 'fixed_region',
        bookId: 'book',
        pageIndex: 3,
        pageHash: 'page-hash',
        quads: [{ x: 0.15, y: 0.25, width: 0.3, height: 0.2 }],
      },
    };
    await repository.save(region);
    expect(await repository.listPage('book', 3)).toEqual([region]);
  });

  it('round-trips a same-page multi-block text selection', async () => {
    const repository = new IndexedDbDocumentAnnotationRepository();
    const multiBlock: DocumentAnnotation = {
      ...annotation,
      id: 'annotation-multi-block',
      quote: '첫 문단\n두 번째 문단',
      anchor: {
        kind: 'fixed_text',
        bookId: 'book',
        pageIndex: 3,
        textRevisionId: 'revision',
        blockId: 'block-1',
        startOffset: 2,
        endOffset: 5,
        blockRanges: [
          { blockId: 'block-1', startOffset: 2, endOffset: 8 },
          { blockId: 'block-2', startOffset: 0, endOffset: 5 },
        ],
        quads: [
          { x: 0.1, y: 0.2, width: 0.3, height: 0.02 },
          { x: 0.1, y: 0.24, width: 0.5, height: 0.02 },
        ],
      },
    };
    await repository.save(multiBlock);
    expect(await repository.listPage('book', 3)).toEqual([multiBlock]);
  });
});
