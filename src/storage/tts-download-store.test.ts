import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetReaderDbForTests } from './reader-database';
import { IndexedDbTTSDownloadRepository } from './tts-download-store';

describe('TTS download store', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('persists item progress and a recoverable partial job', async () => {
    const repository = new IndexedDbTTSDownloadRepository();
    const job = await repository.create({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterIds: ['chapter_1'],
      wholeBook: false,
    });
    await repository.planItems(job.id, [
      { chapterId: 'chapter_1', paragraphId: 'p1', cacheKey: 'hash_1', renderSpecHash: 'hash_1' },
      { chapterId: 'chapter_1', paragraphId: 'p2', cacheKey: 'hash_2', renderSpecHash: 'hash_2' },
    ]);
    await repository.markItemRunning(job.id, 'hash_1');
    await repository.markItemReady(job.id, 'hash_1', { cacheKey: 'cache_1', byteSize: 128 });
    await repository.markItemRunning(job.id, 'hash_2');
    await repository.markItemFailed(job.id, 'hash_2', 'network unavailable');

    const completed = await repository.finish(job.id);
    expect(completed).toMatchObject({
      state: 'partial',
      plannedItems: 2,
      readyItems: 1,
      failedItems: 1,
      byteSize: 128,
    });
    expect(await repository.latestForBook('book_1')).toEqual(completed);
    expect(await repository.listItems(job.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ renderSpecHash: 'hash_1', state: 'ready', attempts: 1 }),
        expect.objectContaining({ renderSpecHash: 'hash_2', state: 'failed', attempts: 1 }),
      ]),
    );
  });

  it('marks an interrupted job as cancelled without discarding ready items', async () => {
    const repository = new IndexedDbTTSDownloadRepository();
    const job = await repository.create({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterIds: ['chapter_1'],
      wholeBook: false,
    });
    await repository.planItems(job.id, [{ chapterId: 'chapter_1', cacheKey: 'hash_1', renderSpecHash: 'hash_1' }]);
    await repository.markItemReady(job.id, 'hash_1', { cacheKey: 'cache_1', byteSize: 64 });

    expect(await repository.cancel(job.id)).toMatchObject({ state: 'cancelled', readyItems: 1, byteSize: 64 });
  });

  it('selects the latest job only from the active content revision', async () => {
    const repository = new IndexedDbTTSDownloadRepository();
    const current = await repository.create({
      bookId: 'book_1',
      contentRevisionId: 'revision_current',
      chapterIds: ['chapter_1'],
      wholeBook: false,
    });
    await repository.create({
      bookId: 'book_1',
      contentRevisionId: 'revision_old',
      chapterIds: ['chapter_1'],
      wholeBook: false,
    });

    await expect(repository.latestForBookRevision('book_1', 'revision_current')).resolves.toEqual(current);
    await expect(repository.latestForBookRevision('book_1', 'revision_missing')).resolves.toBeUndefined();
  });

  it('recovers interrupted running and retry-wait items as an explicit resumable failure', async () => {
    const repository = new IndexedDbTTSDownloadRepository();
    const job = await repository.create({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterIds: ['chapter_1'],
      wholeBook: false,
    });
    await repository.planItems(job.id, [
      { chapterId: 'chapter_1', cacheKey: 'hash_1', renderSpecHash: 'hash_1' },
      { chapterId: 'chapter_1', cacheKey: 'hash_2', renderSpecHash: 'hash_2' },
      { chapterId: 'chapter_1', cacheKey: 'hash_3', renderSpecHash: 'hash_3' },
    ]);
    await repository.markItemReady(job.id, 'hash_1', { cacheKey: 'cache_1', byteSize: 64 });
    await repository.markItemRunning(job.id, 'hash_2');
    await repository.markItemRetryWait(job.id, 'hash_2', 'network unavailable', '2026-08-01T00:01:00.000Z');

    await expect(repository.recoverInterrupted()).resolves.toBe(1);
    await expect(repository.get(job.id)).resolves.toMatchObject({ state: 'partial', readyItems: 1, failedItems: 2 });
    await expect(repository.listItems(job.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          renderSpecHash: 'hash_2',
          state: 'failed',
          nextAttemptAt: undefined,
          errorMessage: expect.stringContaining('중단'),
        }),
        expect.objectContaining({
          renderSpecHash: 'hash_3',
          state: 'failed',
          errorMessage: expect.stringContaining('중단'),
        }),
      ]),
    );
  });

  it('reconciles headless native cache completion before failing interrupted items', async () => {
    const repository = new IndexedDbTTSDownloadRepository();
    const job = await repository.create({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterIds: ['chapter_1'],
      wholeBook: false,
    });
    await repository.planItems(job.id, [
      { chapterId: 'chapter_1', cacheKey: 'hash_1', renderSpecHash: 'hash_1' },
      { chapterId: 'chapter_1', cacheKey: 'hash_2', renderSpecHash: 'hash_2' },
    ]);
    await repository.markItemRunning(job.id, 'hash_1');
    await repository.markItemRunning(job.id, 'hash_2');

    await expect(repository.interruptedRenderSpecHashes()).resolves.toEqual(['hash_1', 'hash_2']);
    await expect(
      repository.recoverInterrupted([{ renderSpecHash: 'hash_1', cacheKey: 'cache_1', byteSize: 96 }]),
    ).resolves.toBe(1);

    await expect(repository.get(job.id)).resolves.toMatchObject({ state: 'partial', readyItems: 1, failedItems: 1 });
    await expect(repository.listItems(job.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ renderSpecHash: 'hash_1', state: 'ready', cacheKey: 'cache_1', byteSize: 96 }),
        expect.objectContaining({ renderSpecHash: 'hash_2', state: 'failed' }),
      ]),
    );
  });
});
