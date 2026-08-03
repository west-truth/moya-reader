import { applyDocumentTextOrderOverride, documentTextBlockFingerprint } from '../domain/document-text-order';
import type { DocumentTextBlock, DocumentTextOrderOverride, DocumentTextRevision } from '../domain/types';
import type { DocumentTextRepository, DocumentTextSearchResult } from '../repositories/document-text-repository';
import { DOCUMENT_LISTENING_STORES } from './document-listening-schema';
import { getAllByIndex, getItem, putItem, requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';
import { jsonValue, queueSyncEventInTransaction, tombstoneEntity, tombstoneId } from './sync-event-store';

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

export class IndexedDbDocumentTextRepository implements DocumentTextRepository {
  async findReadyRevision(
    bookId: string,
    pageIndex: number,
    pageHash: string,
  ): Promise<DocumentTextRevision | undefined> {
    const rows = await getAllByIndex<DocumentTextRevision>(
      DOCUMENT_LISTENING_STORES.documentTextRevisions,
      'bookId_pageIndex',
      IDBKeyRange.only([bookId, pageIndex]),
    );
    return rows
      .filter((row) => row.pageHash === pageHash && row.status === 'ready')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  listRevisions(bookId: string): Promise<DocumentTextRevision[]> {
    return getAllByIndex<DocumentTextRevision>(DOCUMENT_LISTENING_STORES.documentTextRevisions, 'bookId', bookId).then(
      (rows) =>
        rows.sort((left, right) => left.pageIndex - right.pageIndex || left.updatedAt.localeCompare(right.updatedAt)),
    );
  }

  async listReadyRevisions(bookId: string): Promise<DocumentTextRevision[]> {
    const rows = await getAllByIndex<DocumentTextRevision>(
      DOCUMENT_LISTENING_STORES.documentTextRevisions,
      'bookId',
      bookId,
    );
    const latestByPage = new Map<number, DocumentTextRevision>();
    rows
      .filter((row) => row.status === 'ready')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .forEach((row) => {
        if (!latestByPage.has(row.pageIndex)) latestByPage.set(row.pageIndex, row);
      });
    return [...latestByPage.values()].sort((left, right) => left.pageIndex - right.pageIndex);
  }

  getRawBlocks(revisionId: string): Promise<DocumentTextBlock[]> {
    return getAllByIndex<DocumentTextBlock>(
      DOCUMENT_LISTENING_STORES.documentTextBlocks,
      'revisionId',
      revisionId,
    ).then((rows) => rows.sort((left, right) => left.order - right.order));
  }

  async getBlocks(revisionId: string): Promise<DocumentTextBlock[]> {
    const [revision, blocks] = await Promise.all([
      getItem<DocumentTextRevision>(DOCUMENT_LISTENING_STORES.documentTextRevisions, revisionId),
      this.getRawBlocks(revisionId),
    ]);
    if (!revision) return blocks;
    return applyDocumentTextOrderOverride(blocks, await this.getOrderOverride(revision.bookId, revision.pageIndex));
  }

  getOrderOverride(bookId: string, pageIndex: number): Promise<DocumentTextOrderOverride | undefined> {
    return getAllByIndex<DocumentTextOrderOverride>(
      DOCUMENT_LISTENING_STORES.documentTextOrderOverrides,
      'bookId_pageIndex',
      IDBKeyRange.only([bookId, pageIndex]),
    ).then((rows) => rows[0]);
  }

  async saveOrderOverride(override: DocumentTextOrderOverride): Promise<void> {
    const db = await openReaderDb();
    const tx = db.transaction(
      [DOCUMENT_LISTENING_STORES.documentTextOrderOverrides, 'sync_tombstones', 'devices', 'sync_outbox', 'sync_state'],
      'readwrite',
    );
    tx.objectStore(DOCUMENT_LISTENING_STORES.documentTextOrderOverrides).put(override);
    tx.objectStore('sync_tombstones').delete(tombstoneId('document_text_order_override', override.id));
    await queueSyncEventInTransaction(
      tx,
      'document_text_order_override_updated',
      jsonValue({ orderOverride: override }),
      { novelId: override.bookId, entityId: override.id },
    );
    await transactionDone(tx);
  }

  async removeOrderOverride(id: string): Promise<void> {
    const db = await openReaderDb();
    const tx = db.transaction(
      [DOCUMENT_LISTENING_STORES.documentTextOrderOverrides, 'sync_tombstones', 'devices', 'sync_outbox', 'sync_state'],
      'readwrite',
    );
    const store = tx.objectStore(DOCUMENT_LISTENING_STORES.documentTextOrderOverrides);
    const existing = await requestToPromise<DocumentTextOrderOverride | undefined>(store.get(id));
    store.delete(id);
    if (existing) {
      const deletedAt = new Date().toISOString();
      tx.objectStore('sync_tombstones').put({
        ...tombstoneEntity('document_text_order_override', id, deletedAt, existing.bookId),
        pageIndex: existing.pageIndex,
      });
      await queueSyncEventInTransaction(
        tx,
        'document_text_order_override_deleted',
        jsonValue({ id, orderOverride: existing, pageIndex: existing.pageIndex, deletedAt }),
        { novelId: existing.bookId, entityId: id },
      );
    }
    await transactionDone(tx);
  }

  saveRevision(revision: DocumentTextRevision): Promise<void> {
    return putItem(DOCUMENT_LISTENING_STORES.documentTextRevisions, revision);
  }

  async markRevisionStatus(
    revisionId: string,
    status: DocumentTextRevision['status'],
    errorMessage?: string,
  ): Promise<void> {
    const revision = await getItem<DocumentTextRevision>(DOCUMENT_LISTENING_STORES.documentTextRevisions, revisionId);
    if (!revision) return;
    await this.saveRevision({
      ...revision,
      status,
      errorMessage: errorMessage?.slice(0, 500),
      updatedAt: new Date().toISOString(),
    });
  }

  async recoverInterruptedOcr(bookId: string): Promise<DocumentTextRevision[]> {
    const db = await openReaderDb();
    const tx = db.transaction(DOCUMENT_LISTENING_STORES.documentTextRevisions, 'readwrite');
    const store = tx.objectStore(DOCUMENT_LISTENING_STORES.documentTextRevisions);
    const rows = await requestToPromise<DocumentTextRevision[]>(store.index('bookId').getAll(bookId));
    const readyPages = new Set(
      rows.filter((row) => row.status === 'ready').map((row) => `${row.pageIndex}:${row.pageHash}`),
    );
    const timestamp = new Date().toISOString();
    const failed: DocumentTextRevision[] = [];
    for (const row of rows) {
      if (row.source !== 'ocr' || row.status !== 'pending') continue;
      const completed = readyPages.has(`${row.pageIndex}:${row.pageHash}`);
      const next: DocumentTextRevision = {
        ...row,
        status: completed ? 'stale' : 'failed',
        errorMessage: completed ? undefined : '앱이 종료되어 OCR 작업이 중단되었습니다.',
        updatedAt: timestamp,
      };
      store.put(next);
      if (!completed) failed.push(next);
    }
    await transactionDone(tx);
    return failed;
  }

  async saveReadyPage(revision: DocumentTextRevision, blocks: readonly DocumentTextBlock[]): Promise<void> {
    if (revision.status !== 'ready') throw new Error('Only ready document text revisions can be activated.');
    const db = await openReaderDb();
    const tx = db.transaction(
      [DOCUMENT_LISTENING_STORES.documentTextRevisions, DOCUMENT_LISTENING_STORES.documentTextBlocks],
      'readwrite',
    );
    const revisions = tx.objectStore(DOCUMENT_LISTENING_STORES.documentTextRevisions);
    const blockStore = tx.objectStore(DOCUMENT_LISTENING_STORES.documentTextBlocks);
    const previous = await requestToPromise<DocumentTextRevision[]>(
      revisions.index('bookId_pageIndex').getAll(IDBKeyRange.only([revision.bookId, revision.pageIndex])),
    );
    for (const row of previous) {
      if (row.id !== revision.id && row.status === 'ready') revisions.put({ ...row, status: 'stale' });
    }
    const oldBlockKeys = await requestToPromise<IDBValidKey[]>(blockStore.index('revisionId').getAllKeys(revision.id));
    oldBlockKeys.forEach((key) => blockStore.delete(key));
    blocks.forEach((block) => blockStore.put(block));
    revisions.put(revision);
    await transactionDone(tx);
  }

  async search(bookId: string, query: string, limit = 200): Promise<DocumentTextSearchResult[]> {
    const needle = normalizeSearch(query);
    if (!needle) return [];
    const [revisions, overrides] = await Promise.all([
      this.listReadyRevisions(bookId),
      getAllByIndex<DocumentTextOrderOverride>(DOCUMENT_LISTENING_STORES.documentTextOrderOverrides, 'bookId', bookId),
    ]);
    const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
    const overrideByPage = new Map(overrides.map((override) => [override.pageIndex, override]));
    const rankByPage = new Map(
      overrides.map((override) => [
        override.pageIndex,
        new Map(override.orderedBlockFingerprints.map((fingerprint, index) => [fingerprint, index])),
      ]),
    );
    const results: DocumentTextSearchResult[] = [];
    const db = await openReaderDb();
    const tx = db.transaction(DOCUMENT_LISTENING_STORES.documentTextBlocks, 'readonly');
    const request = tx.objectStore(DOCUMENT_LISTENING_STORES.documentTextBlocks).index('bookId').openCursor(bookId);
    return new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          results.sort(
            (left, right) =>
              left.pageIndex - right.pageIndex ||
              left.blockOrder - right.blockOrder ||
              left.startOffset - right.startOffset,
          );
          resolve(results.slice(0, Math.max(1, limit)));
          return;
        }
        const block = cursor.value as DocumentTextBlock;
        const revision = revisionById.get(block.revisionId);
        const override = overrideByPage.get(block.pageIndex);
        const fingerprint = documentTextBlockFingerprint(block);
        const startOffset = block.normalizedText.indexOf(needle);
        if (revision && startOffset >= 0 && !override?.excludedBlockFingerprints.includes(fingerprint)) {
          results.push({
            pageIndex: block.pageIndex,
            revisionId: block.revisionId,
            blockId: block.id,
            text: block.text,
            startOffset,
            endOffset: startOffset + needle.length,
            quads: block.quads,
            source: revision.source,
            blockOrder: rankByPage.get(block.pageIndex)?.get(fingerprint) ?? block.order,
          });
        }
        cursor.continue();
      };
    });
  }
}
