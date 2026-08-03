import type { DocumentAnnotation } from '../domain/types';
import type { DocumentAnnotationRepository } from '../repositories/document-annotation-repository';
import { DOCUMENT_LISTENING_STORES } from './document-listening-schema';
import { getAllByIndex, requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';
import { jsonValue, queueSyncEventInTransaction, tombstoneEntity, tombstoneId } from './sync-event-store';

export class IndexedDbDocumentAnnotationRepository implements DocumentAnnotationRepository {
  async list(bookId: string): Promise<DocumentAnnotation[]> {
    const rows = await getAllByIndex<DocumentAnnotation>(
      DOCUMENT_LISTENING_STORES.documentAnnotations,
      'bookId',
      bookId,
    );
    return rows.filter((row) => !row.deletedAt).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listPage(bookId: string, pageIndex: number): Promise<DocumentAnnotation[]> {
    const rows = await getAllByIndex<DocumentAnnotation>(
      DOCUMENT_LISTENING_STORES.documentAnnotations,
      'bookId_pageIndex',
      IDBKeyRange.only([bookId, pageIndex]),
    );
    return rows.filter((row) => !row.deletedAt).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async save(annotation: DocumentAnnotation): Promise<void> {
    const db = await openReaderDb();
    const tx = db.transaction(
      [
        DOCUMENT_LISTENING_STORES.documentAnnotations,
        'sync_tombstones',
        'devices',
        'sync_outbox',
        'sync_state',
      ],
      'readwrite',
    );
    const saved = { ...annotation, deletedAt: undefined };
    tx.objectStore(DOCUMENT_LISTENING_STORES.documentAnnotations).put(saved);
    tx.objectStore('sync_tombstones').delete(tombstoneId('document_annotation', annotation.id));
    await queueSyncEventInTransaction(tx, 'document_annotation_updated', jsonValue({ annotation: saved }), {
      novelId: annotation.bookId,
      entityId: annotation.id,
    });
    await transactionDone(tx);
  }

  async remove(id: string, deletedAt = new Date().toISOString()): Promise<void> {
    const db = await openReaderDb();
    const tx = db.transaction(
      [
        DOCUMENT_LISTENING_STORES.documentAnnotations,
        'sync_tombstones',
        'devices',
        'sync_outbox',
        'sync_state',
      ],
      'readwrite',
    );
    const store = tx.objectStore(DOCUMENT_LISTENING_STORES.documentAnnotations);
    const current = await requestToPromise<DocumentAnnotation | undefined>(store.get(id));
    if (!current || current.deletedAt) {
      await transactionDone(tx);
      return;
    }
    store.put({
      ...current,
      deletedAt,
      updatedAt: deletedAt,
    });
    tx.objectStore('sync_tombstones').put(tombstoneEntity('document_annotation', id, deletedAt, current.bookId));
    await queueSyncEventInTransaction(
      tx,
      'document_annotation_deleted',
      jsonValue({ id, annotation: current, deletedAt }),
      { novelId: current.bookId, entityId: id },
    );
    await transactionDone(tx);
  }
}
