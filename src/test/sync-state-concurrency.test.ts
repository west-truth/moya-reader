import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetReaderDbForTests } from '../storage/reader-database';
import { enqueueSyncEvent, getSyncState, listSyncOutbox, saveSyncState } from '../storage/sync-event-store';

function enqueueBookDeletion(novelId: string) {
  return enqueueSyncEvent('book_deleted', { novelId }, { novelId, entityId: novelId });
}

describe('sync state concurrency', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves sequence allocation when state saving races with an enqueue', async () => {
    await enqueueBookDeletion('seed-book');

    const originalGet = IDBObjectStore.prototype.get;
    const originalCount = IDBIndex.prototype.count;
    let syncStateReadStarted = false;
    let concurrentEnqueue: ReturnType<typeof enqueueBookDeletion> | undefined;

    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, query) {
      if (this.name === 'sync_state' && query === 'sync-state') syncStateReadStarted = true;
      return originalGet.call(this, query);
    });
    vi.spyOn(IDBIndex.prototype, 'count').mockImplementation(function (this: IDBIndex, query) {
      const request = query === undefined ? originalCount.call(this) : originalCount.call(this, query);
      const transaction = this.objectStore.transaction;
      const atomicSaveTransaction =
        transaction.mode === 'readwrite' &&
        transaction.objectStoreNames.length === 2 &&
        transaction.objectStoreNames.contains('sync_outbox') &&
        transaction.objectStoreNames.contains('sync_state');

      if (
        this.name === 'status' &&
        query === 'failed' &&
        (atomicSaveTransaction || (transaction.mode === 'readonly' && syncStateReadStarted))
      ) {
        request.addEventListener('success', () => {
          concurrentEnqueue ??= enqueueBookDeletion('racing-book');
        });
      }
      return request;
    });

    await saveSyncState({ mode: 'connected', status: 'idle' });
    if (!concurrentEnqueue) throw new Error('concurrent enqueue was not started');
    await concurrentEnqueue;

    const racedOutbox = await listSyncOutbox();
    const racedState = await getSyncState();
    expect(racedState).toMatchObject({ mode: 'connected', status: 'idle', pendingCount: racedOutbox.length });
    expect(racedState.nextSequence).toBe(Math.max(...racedOutbox.map((item) => item.localSequence)) + 1);

    await enqueueBookDeletion('after-race-book');
    const finalOutbox = await listSyncOutbox();
    const sequences = finalOutbox.map((item) => item.localSequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect((await getSyncState()).nextSequence).toBe(Math.max(...sequences) + 1);
  });
});
