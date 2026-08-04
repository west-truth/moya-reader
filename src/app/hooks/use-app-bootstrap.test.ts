import { describe, expect, it, vi } from 'vitest';
import { ConnectedSyncController } from '../../sync/connected-sync-controller';
import { runGuardedAppBootstrap } from './use-app-bootstrap';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const initialSelection = {
  view: 'library' as const,
  chapterProgress: 0,
};

describe('runGuardedAppBootstrap', () => {
  it('never commits a stale snapshot after runtime replacement', async () => {
    let runtimeCurrent = true;
    const controller = new ConnectedSyncController(initialSelection, () => runtimeCurrent);
    const snapshot = deferred<{ novels: string[] }>();
    const commitState = vi.fn();
    const initialFlush = vi.fn(async () => undefined);
    const bootstrap = controller.startBootstrap((context) =>
      runGuardedAppBootstrap(context, {
        load: () => snapshot.promise,
        commit: commitState,
        afterCommit: initialFlush,
      }),
    );
    await Promise.resolve();

    runtimeCurrent = false;
    controller.dispose();
    snapshot.resolve({ novels: ['stale-book'] });
    await bootstrap;

    expect(commitState).not.toHaveBeenCalled();
    expect(initialFlush).not.toHaveBeenCalled();
  });

  it('commits one initial snapshot and preserves one initial connected flush', async () => {
    const controller = new ConnectedSyncController(initialSelection);
    const commitState = vi.fn();
    const initialFlush = vi.fn(async () => undefined);
    const run = () =>
      controller.startBootstrap((context) =>
        runGuardedAppBootstrap(context, {
          load: async () => ({ novels: ['book-a'] }),
          commit: commitState,
          afterCommit: initialFlush,
        }),
      );

    await run();
    controller.updateSelection({
      view: 'reader',
      bookId: 'book-a',
      chapterId: 'chapter-a',
      chapterProgress: 0.4,
    });
    await run();

    expect(commitState).toHaveBeenCalledTimes(1);
    expect(initialFlush).toHaveBeenCalledTimes(1);
  });
});
