import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listSyncOutboxInDatabase } from '../storage/sync-outbox-store';
import { mayHaveQueuedProviderMetadata, loadSyncOutboxDetails, SYNC_OUTBOX_PREVIEW_LIMIT } from './outbox-queries';
import type { SyncEventType, SyncOutboxItem, SyncOutboxQueryOptions } from './types';

let database: IDBDatabase | undefined;
afterEach(() => {
  database?.close();
  vi.restoreAllMocks();
});

function item(
  index: number,
  status: SyncOutboxItem['status'],
  type: SyncEventType = 'reading_position_updated',
): SyncOutboxItem {
  return {
    id: String(index).padStart(6, '0'),
    status,
    localSequence: index,
    attempts: 0,
    createdAt: '2026-09-05T00:00:00Z',
    updatedAt: '2026-09-05T00:00:00Z',
    event: { id: `event-${index}`, type, deviceId: 'fixture', payload: {}, createdAt: '2026-09-05T00:00:00Z' },
  };
}

async function seed(items: SyncOutboxItem[]) {
  database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`outbox-query-${crypto.randomUUID()}`, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('sync_outbox', { keyPath: 'id' }).createIndex('status', 'status');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const tx = database.transaction('sync_outbox', 'readwrite');
  for (const value of items) tx.objectStore('sync_outbox').put(value);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return {
    listSyncOutbox: (status?: SyncOutboxItem['status'], options?: SyncOutboxQueryOptions) =>
      listSyncOutboxInDatabase(database!, status, options),
  };
}

describe('outbox UI and provider queries', () => {
  it('bounds the status-index preview without loading sent history or truncating explicit full queries', async () => {
    const pending = Array.from({ length: 135 }, (_, index) => item(index, 'pending'));
    const repository = await seed([
      ...pending,
      ...Array.from({ length: 1000 }, (_, index) => item(1000 + index, 'sent')),
    ]);
    const getAll = vi.spyOn(IDBIndex.prototype, 'getAll');
    const cursorContinue = vi.spyOn(IDBCursor.prototype, 'continue');
    const preview = await loadSyncOutboxDetails(repository);
    expect(preview.truncated).toBe(true);
    expect(preview.items).toHaveLength(SYNC_OUTBOX_PREVIEW_LIMIT);
    expect(getAll).not.toHaveBeenCalled();
    expect(cursorContinue).toHaveBeenCalledTimes(SYNC_OUTBOX_PREVIEW_LIMIT);
    const complete = await loadSyncOutboxDetails(repository, true);
    expect(complete).toEqual({ items: pending, truncated: false });
    expect(await repository.listSyncOutbox()).toHaveLength(1135);
  });

  it('treats a large uninspected queue as sync-first without scanning beyond the bound', async () => {
    const repository = await seed([
      item(0, 'sent', 'chapter_segments_updated'),
      ...Array.from({ length: 135 }, (_, index) => item(index + 1, 'pending')),
      item(999, 'pending', 'character_graph_updated'),
    ]);
    const preview = await loadSyncOutboxDetails(repository);
    expect(preview.items.every((entry) => entry.event.type === 'reading_position_updated')).toBe(true);
    const cursorContinue = vi.spyOn(IDBCursor.prototype, 'continue');
    expect(await mayHaveQueuedProviderMetadata(repository)).toBe(true);
    expect(cursorContinue).toHaveBeenCalledTimes(SYNC_OUTBOX_PREVIEW_LIMIT);
    const tx = database!.transaction('sync_outbox', 'readwrite');
    tx.objectStore('sync_outbox').delete('000999');
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    cursorContinue.mockClear();
    expect(await mayHaveQueuedProviderMetadata(repository)).toBe(true);
    expect(cursorContinue).toHaveBeenCalledTimes(SYNC_OUTBOX_PREVIEW_LIMIT);
  });

  it('does not require a sync for a small progress-only queue or sent metadata', async () => {
    const repository = await seed([
      item(0, 'sent', 'chapter_segments_updated'),
      item(1, 'pending'),
      item(2, 'failed'),
      item(3, 'sending'),
    ]);
    expect(await mayHaveQueuedProviderMetadata(repository)).toBe(false);
    const tx = database!.transaction('sync_outbox', 'readwrite');
    tx.objectStore('sync_outbox').put(item(4, 'failed', 'character_graph_updated'));
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    expect(await mayHaveQueuedProviderMetadata(repository)).toBe(true);
  });
});
