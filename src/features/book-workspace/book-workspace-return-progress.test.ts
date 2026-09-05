import { describe, expect, it, vi } from 'vitest';
import { BookWorkspaceController } from './book-workspace-controller';
import { createBookWorkspaceTestHarness, testNovel, testWorkspaceState } from './book-workspace-test-fixtures';

describe('Reader return progress refresh', () => {
  it('publishes flushed progress to the selected book and library before opening source details', async () => {
    const previous = testNovel({ lastReadChapterId: 'chapter-2', lastReadChapterIndex: 2, lastReadProgress: 1 / 3 });
    const fresh = testNovel({ lastReadChapterId: 'chapter-3', lastReadChapterIndex: 3, lastReadProgress: 2 / 3 });
    const other = testNovel({ id: 'other-book' });
    const harness = createBookWorkspaceTestHarness({ novel: fresh });
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({
        selectedNovel: previous,
        novels: [previous, other],
        view: 'reader',
      }),
    );
    const returned = vi.fn((novel) => {
      expect(novel).toBe(fresh);
      expect(controller.getSnapshot()).toMatchObject({
        selectedNovel: fresh,
        novels: [fresh, other],
        view: 'chapters',
      });
    });

    await controller.returnToChaptersAndThen(returned);

    expect(returned).toHaveBeenCalledOnce();
    expect(harness.calls).toEqual(['transition.stopReaderTTS', 'transition.flushReaderSession', 'repository.getNovel']);
  });

  it('keeps returning with the current book if the fresh progress lookup fails', async () => {
    const previous = testNovel({ lastReadChapterId: 'chapter-2', lastReadProgress: 1 / 3 });
    const harness = createBookWorkspaceTestHarness({ novel: previous });
    harness.ports.repository.getNovel = vi.fn(async () => {
      throw new Error('temporary lookup failure');
    });
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({
        selectedNovel: previous,
        novels: [previous],
        view: 'reader',
      }),
    );
    const returned = vi.fn();

    await expect(controller.returnToChaptersAndThen(returned)).resolves.toBeUndefined();

    expect(returned).toHaveBeenCalledWith(previous);
    expect(controller.getSnapshot()).toMatchObject({ selectedNovel: previous, novels: [previous], view: 'chapters' });
  });
});
