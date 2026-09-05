import { describe, expect, it } from 'vitest';
import { BookWorkspaceController } from './book-workspace-controller';
import {
  createBookWorkspaceTestHarness,
  testChapter,
  testNovel,
  testPosition,
  testWorkspaceState,
} from './book-workspace-test-fixtures';

describe('continue reading from source series details', () => {
  it('restores the same-book chapter list so previous and next chapters remain available', async () => {
    const novel = testNovel({ activeContentRevisionId: 'revision-1', lastReadChapterId: 'chapter-2' });
    const chapters = [testChapter(1), testChapter(2), testChapter(3)];
    const harness = createBookWorkspaceTestHarness({ novel, chapters, position: testPosition() });
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ selectedNovel: novel, chapters: [], view: 'library' }),
    );

    await controller.continueReading();

    expect(controller.getSnapshot()).toMatchObject({
      selectedNovel: novel,
      currentChapter: chapters[1],
      chapters,
      view: 'reader',
    });
    expect(harness.calls).toContain('repository.listChapters');
    await controller.openChapter(chapters[2]!);
    expect(controller.getSnapshot().currentChapter).toBe(chapters[2]);
    await controller.openChapter(chapters[0]!);
    expect(controller.getSnapshot().currentChapter).toBe(chapters[0]);
  });

  it('reloads cached chapters when the fresh book has a newer content revision', async () => {
    const previous = testNovel({ activeContentRevisionId: 'revision-1' });
    const fresh = testNovel({ activeContentRevisionId: 'revision-2', title: 'Fresh title' });
    const oldChapters = [testChapter(1, { id: 'old-chapter' })];
    const chapters = [testChapter(1), testChapter(2), testChapter(3)];
    const harness = createBookWorkspaceTestHarness({ novel: fresh, chapters, position: testPosition() });
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ selectedNovel: previous, chapters: oldChapters, view: 'library' }),
    );

    await controller.continueReading(previous);

    expect(controller.getSnapshot()).toMatchObject({
      selectedNovel: fresh,
      currentChapter: chapters[1],
      chapters,
      view: 'reader',
    });
    expect(harness.calls.filter((call) => call === 'repository.listChapters')).toHaveLength(1);
    expect(harness.preparedOpens[0]?.chapterId).toBe('chapter-2');
  });
});
