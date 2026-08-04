import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectedSyncController, type ConnectedSyncSelection } from './connected-sync-controller';

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function selection(bookId = 'book-a', chapterId = 'chapter-a'): ConnectedSyncSelection<string, string> {
  return {
    view: 'reader',
    bookId,
    chapterId,
    chapterProgress: 0.25,
    book: bookId,
    chapter: chapterId,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ConnectedSyncController', () => {
  it('runs connected bootstrap once and does not create an idle flush timer', async () => {
    vi.useFakeTimers();
    const controller = new ConnectedSyncController(selection());
    let flushes = 0;
    const bootstrap = () =>
      controller.startBootstrap(async () => {
        flushes += 1;
      });

    await bootstrap();
    await vi.advanceTimersByTimeAsync(60_000);
    await bootstrap();

    expect(flushes).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets concurrent manual and provider triggers share the service single-flight', async () => {
    const controller = new ConnectedSyncController(selection());
    const gate = deferred<{ status: 'idle' }>();
    let activeFlush: Promise<{ status: 'idle' }> | undefined;
    let underlyingFlushes = 0;
    let commits = 0;
    const flushPending = () => {
      if (activeFlush) return activeFlush;
      underlyingFlushes += 1;
      activeFlush = gate.promise.finally(() => {
        activeFlush = undefined;
      });
      return activeFlush;
    };

    const manual = controller.runSelectionTask('connected-sync-flush', {
      load: flushPending,
      commit: () => {
        commits += 1;
      },
    });
    const providerPreflight = controller.runSelectionTask('connected-sync-flush', {
      load: flushPending,
      commit: () => {
        commits += 1;
      },
    });

    expect(underlyingFlushes).toBe(1);
    gate.resolve({ status: 'idle' });
    await Promise.all([manual, providerPreflight]);

    expect(underlyingFlushes).toBe(1);
    expect(commits).toBe(1);
  });

  it('aborts a replaced runtime and fences its stale bootstrap result', async () => {
    let runtimeCurrent = true;
    const controller = new ConnectedSyncController(selection(), () => runtimeCurrent);
    const gate = deferred<void>();
    let bootstrapSignal: AbortSignal | undefined;
    let applied = 0;
    const bootstrap = controller.startBootstrap(async (context) => {
      bootstrapSignal = context.signal;
      await gate.promise;
      if (context.isCurrent()) applied += 1;
    });
    await Promise.resolve();

    runtimeCurrent = false;
    controller.dispose();
    gate.resolve(undefined);
    await bootstrap;

    expect(bootstrapSignal?.aborted).toBe(true);
    expect(applied).toBe(0);
  });

  it('uses selection ids to suppress stale refreshes without restarting bootstrap', async () => {
    const controller = new ConnectedSyncController(selection());
    const gate = deferred<string>();
    let bootstrapRuns = 0;
    let appliedRefreshes = 0;
    let settledStaleRefresh = false;

    await controller.startBootstrap(async () => {
      bootstrapRuns += 1;
    });
    const refresh = controller.runSelectionTask('reader-refresh', {
      load: () => gate.promise,
      commit: () => {
        appliedRefreshes += 1;
      },
      settle: (context) => {
        settledStaleRefresh = context.isLatestTask() && !context.isSelectionCurrent();
      },
    });
    controller.updateSelection(selection('book-b', 'chapter-b'));
    await controller.startBootstrap(async () => {
      bootstrapRuns += 1;
    });
    gate.resolve('stale');

    await expect(refresh).resolves.toBeUndefined();
    expect(appliedRefreshes).toBe(0);
    expect(settledStaleRefresh).toBe(true);
    expect(bootstrapRuns).toBe(1);
  });

  it('does not invalidate a refresh for same-id object identity churn', async () => {
    const firstBook = { id: 'book-a', revision: 1 };
    const firstChapter = { id: 'chapter-a', revision: 1 };
    const controller = new ConnectedSyncController({
      view: 'reader',
      bookId: firstBook.id,
      chapterId: firstChapter.id,
      chapterProgress: 0.2,
      book: firstBook,
      chapter: firstChapter,
    });
    const gate = deferred<string>();
    const commit = vi.fn();
    const refresh = controller.runSelectionTask('reader-refresh', {
      load: () => gate.promise,
      commit,
    });

    controller.updateSelection({
      view: 'reader',
      bookId: firstBook.id,
      chapterId: firstChapter.id,
      chapterProgress: 0.3,
      book: { ...firstBook, revision: 2 },
      chapter: { ...firstChapter, revision: 2 },
    });
    gate.resolve('fresh-for-current-selection');

    await expect(refresh).resolves.toBe('fresh-for-current-selection');
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('aborts in-flight selection work on unmount disposal without committing', async () => {
    const controller = new ConnectedSyncController(selection());
    const gate = deferred<string>();
    const commit = vi.fn();
    let taskSignal: AbortSignal | undefined;
    const refresh = controller.runSelectionTask('reader-refresh', {
      load: (context) => {
        taskSignal = context.signal;
        return gate.promise;
      },
      commit,
    });

    controller.dispose();
    gate.resolve('stale-after-unmount');
    await refresh;

    expect(taskSignal?.aborted).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });

  it('coalesces only explicitly scheduled local mutation pushes and cancels them on dispose', async () => {
    vi.useFakeTimers();
    const controller = new ConnectedSyncController(selection());
    let pushes = 0;
    const push = async () => {
      pushes += 1;
    };

    await vi.advanceTimersByTimeAsync(5_000);
    expect(pushes).toBe(0);

    controller.scheduleMutationPush(push, 500);
    controller.scheduleMutationPush(push, 500);
    await vi.advanceTimersByTimeAsync(499);
    expect(pushes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pushes).toBe(1);

    controller.scheduleMutationPush(push, 500);
    controller.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(pushes).toBe(1);
  });
});
