import 'fake-indexeddb/auto';
import type { DocumentTextBlock, DocumentTextRevision } from '../domain/types';
import type { SyncEvent } from '../sync/types';
import { createDocumentTextOrderOverride } from '../domain/document-text-order';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetReaderDbForTests } from './reader-database';
import { applyRemoteSyncEvents } from './db';
import { IndexedDbDocumentTextRepository } from './document-text-store';
import { getAllRecords } from './indexeddb-transaction';
import { jsonValue, listSyncOutbox, type SyncTombstone } from './sync-event-store';

function revision(id: string, pageHash: string, updatedAt: string): DocumentTextRevision {
  return {
    id,
    bookId: 'book',
    pageIndex: 0,
    pageHash,
    source: 'pdf_native',
    engine: 'pdfjs',
    engineVersion: '5',
    status: 'ready',
    qualityScore: 0.9,
    createdAt: updatedAt,
    updatedAt,
  };
}

function block(
  revisionId: string,
  text: string,
  options: { readonly order?: number; readonly y?: number; readonly role?: DocumentTextBlock['role'] } = {},
): DocumentTextBlock {
  const order = options.order ?? 0;
  return {
    id: `${revisionId}:block:${order}`,
    revisionId,
    bookId: 'book',
    pageIndex: 0,
    order,
    role: options.role ?? 'paragraph',
    text,
    normalizedText: text.normalize('NFKC').toLocaleLowerCase(),
    quads: [{ x: 0.1, y: options.y ?? 0.2, width: 0.4, height: 0.03 }],
    direction: 'ltr',
  };
}

describe('IndexedDbDocumentTextRepository', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('atomically activates the new page revision and searches only active blocks', async () => {
    const repository = new IndexedDbDocumentTextRepository();
    const first = revision('revision-1', 'page-old', '2026-08-01T00:00:00.000Z');
    const second = revision('revision-2', 'page-new', '2026-08-01T00:01:00.000Z');
    await repository.saveReadyPage(first, [block(first.id, 'Old sentence')]);
    await repository.saveReadyPage(second, [block(second.id, '새 문장 Search Target')]);

    expect(await repository.findReadyRevision('book', 0, 'page-old')).toBeUndefined();
    expect(await repository.findReadyRevision('book', 0, 'page-new')).toEqual(second);
    expect(await repository.search('book', 'search target')).toEqual([
      expect.objectContaining({ pageIndex: 0, revisionId: second.id, text: '새 문장 Search Target' }),
    ]);
    expect(await repository.search('book', 'old sentence')).toEqual([]);
  });

  it('recovers abandoned OCR revisions without downgrading an already completed page', async () => {
    const repository = new IndexedDbDocumentTextRepository();
    const interrupted: DocumentTextRevision = {
      ...revision('ocr-pending-0', 'page-0', '2026-08-01T00:00:00.000Z'),
      source: 'ocr',
      engine: 'local-tesseract-v7',
      engineVersion: 'pending',
      status: 'pending',
    };
    const completed = {
      ...revision('ocr-ready-1', 'page-1', '2026-08-01T00:01:00.000Z'),
      pageIndex: 1,
      source: 'ocr' as const,
    };
    const stalePending: DocumentTextRevision = {
      ...completed,
      id: 'ocr-pending-1',
      engineVersion: 'pending',
      status: 'pending',
    };
    await repository.saveRevision(interrupted);
    await repository.saveReadyPage(completed, [{ ...block(completed.id, '완료된 OCR'), pageIndex: 1 }]);
    await repository.saveRevision(stalePending);

    await expect(repository.recoverInterruptedOcr('book')).resolves.toEqual([
      expect.objectContaining({ id: interrupted.id, status: 'failed', errorMessage: expect.stringContaining('중단') }),
    ]);
    await expect(repository.recoverInterruptedOcr('book')).resolves.toEqual([]);
    await expect(repository.listRevisions('book')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: interrupted.id, status: 'failed' }),
        expect.objectContaining({ id: stalePending.id, status: 'stale', errorMessage: undefined }),
        expect.objectContaining({ id: completed.id, status: 'ready' }),
      ]),
    );
  });

  it('projects persistent reading-order and exclusion overrides into reads and search', async () => {
    const repository = new IndexedDbDocumentTextRepository();
    const current = revision('revision-order', 'page-order', '2026-08-01T01:00:00.000Z');
    const first = block(current.id, 'First searchable sentence', { order: 0, y: 0.2 });
    const second = block(current.id, 'Second searchable sentence', { order: 1, y: 0.4 });
    const footer = block(current.id, 'Footer searchable sentence', { order: 2, y: 0.9, role: 'caption' });
    await repository.saveReadyPage(current, [first, second, footer]);

    const override = createDocumentTextOrderOverride({
      revision: current,
      orderedBlocks: [second, first, footer],
      excludedBlockIds: new Set([footer.id]),
      now: '2026-08-01T01:01:00.000Z',
    });
    await repository.saveOrderOverride(override);

    await expect(repository.getBlocks(current.id)).resolves.toMatchObject([
      { id: second.id, order: 0 },
      { id: first.id, order: 1 },
    ]);
    await expect(repository.search('book', 'searchable')).resolves.toMatchObject([
      { blockId: second.id, blockOrder: 0 },
      { blockId: first.id, blockOrder: 1 },
    ]);
    await expect(repository.search('book', 'footer')).resolves.toEqual([]);

    await repository.removeOrderOverride(override.id);
    await expect(repository.getBlocks(current.id)).resolves.toMatchObject([
      { id: first.id, order: 0 },
      { id: second.id, order: 1 },
      { id: footer.id, order: 2 },
    ]);
    await expect(getAllRecords<SyncTombstone>('sync_tombstones')).resolves.toEqual([
      expect.objectContaining({
        entityType: 'document_text_order_override',
        entityId: override.id,
        novelId: 'book',
        pageIndex: 0,
      }),
    ]);

    await repository.saveOrderOverride({ ...override, updatedAt: '2026-08-01T01:02:00.000Z' });
    await expect(getAllRecords<SyncTombstone>('sync_tombstones')).resolves.toEqual([]);
    expect((await listSyncOutbox()).map((item) => item.event.type)).toEqual([
      'document_text_order_override_updated',
      'document_text_order_override_deleted',
      'document_text_order_override_updated',
    ]);
  });

  it('applies only newer remote reading-order updates and deletion tombstones', async () => {
    const repository = new IndexedDbDocumentTextRepository();
    const current = revision('revision-remote-order', 'page-remote-order', '2026-08-01T02:00:00.000Z');
    const first = block(current.id, 'First', { order: 0 });
    const second = block(current.id, 'Second', { order: 1 });
    await repository.saveReadyPage(current, [first, second]);
    const override = createDocumentTextOrderOverride({
      revision: current,
      orderedBlocks: [second, first],
      excludedBlockIds: new Set(),
      now: '2026-08-01T02:01:00.000Z',
    });
    const event = (type: SyncEvent['type'], payload: unknown, createdAt: string): SyncEvent => ({
      id: `event-${type}-${createdAt}`,
      type,
      deviceId: 'remote-device',
      novelId: override.bookId,
      entityId: override.id,
      payload: jsonValue(payload),
      createdAt,
    });

    await applyRemoteSyncEvents([
      event('document_text_order_override_updated', { orderOverride: override }, override.updatedAt),
      event(
        'document_text_order_override_deleted',
        { id: override.id, pageIndex: 0, deletedAt: '2026-08-01T02:00:30.000Z' },
        '2026-08-01T02:00:30.000Z',
      ),
    ]);
    await expect(repository.getOrderOverride('book', 0)).resolves.toEqual(override);

    const deletedAt = '2026-08-01T02:02:00.000Z';
    await applyRemoteSyncEvents([
      event('document_text_order_override_deleted', { id: override.id, pageIndex: 0, deletedAt }, deletedAt),
    ]);
    await expect(repository.getOrderOverride('book', 0)).resolves.toBeUndefined();
    await expect(getAllRecords<SyncTombstone>('sync_tombstones')).resolves.toEqual([
      expect.objectContaining({
        entityType: 'document_text_order_override',
        entityId: override.id,
        novelId: 'book',
        pageIndex: 0,
        deletedAt,
      }),
    ]);
  });
});
