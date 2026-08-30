import { describe, expect, it, vi } from 'vitest';
import { BookWorkspaceController } from './book-workspace-controller';
import {
  createBookWorkspaceTestHarness,
  testChapter,
  testNovel,
  testPosition,
  testWorkspaceState,
} from './book-workspace-test-fixtures';

describe('BookWorkspaceController commands', () => {
  it('keeps favorite and title persistence ahead of catalog and sync refreshes', async () => {
    const novel = testNovel();
    const favoriteHarness = createBookWorkspaceTestHarness({ novel });
    const favoriteController = new BookWorkspaceController(
      favoriteHarness.ports,
      testWorkspaceState({ selectedNovel: novel, novels: [novel] }),
    );

    await favoriteController.toggleFavorite(novel);

    expect(favoriteHarness.calls).toEqual([
      'repository.patchNovelMetadata',
      'adjacent.refreshNovels',
      'adjacent.refreshAfterLocalMutation',
    ]);
    expect(favoriteController.getSnapshot().selectedNovel?.favorite).toBe(true);

    const titledNovel = testNovel({ title: '바뀐 제목' });
    const titleHarness = createBookWorkspaceTestHarness({ novel: titledNovel });
    const titleController = new BookWorkspaceController(
      titleHarness.ports,
      testWorkspaceState({ selectedNovel: novel, novels: [novel], bookTitleDraft: '  바뀐 제목  ' }),
    );

    await titleController.saveBookTitle();

    expect(titleHarness.calls).toEqual([
      'repository.patchNovelMetadata',
      'repository.getNovel',
      'adjacent.refreshNovels',
      'adjacent.refreshAfterLocalMutation',
      'environment.notify:success',
    ]);
    expect(titleController.getSnapshot()).toMatchObject({
      selectedNovel: titledNovel,
      bookTitleDraft: '바뀐 제목',
      bookTitleEditing: false,
    });
  });

  it('does not restore an old book selection when its title save finishes after navigation', async () => {
    const firstNovel = testNovel({ id: 'book-1', title: '첫 책' });
    const secondNovel = testNovel({ id: 'book-2', title: '둘째 책' });
    let releaseSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const harness = createBookWorkspaceTestHarness({ novel: { ...firstNovel, title: '저장된 제목' } });
    harness.ports.repository.patchNovelMetadata = async () => {
      harness.calls.push('repository.patchNovelMetadata');
      await saveGate;
    };
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({
        novels: [firstNovel, secondNovel],
        selectedNovel: firstNovel,
        bookTitleDraft: '저장된 제목',
        bookTitleEditing: true,
      }),
    );

    const save = controller.saveBookTitle();
    controller.setSelectedNovel(secondNovel);
    releaseSave?.();
    await save;

    expect(controller.getSnapshot()).toMatchObject({
      selectedNovel: secondNovel,
      bookTitleDraft: secondNovel.title,
      bookTitleEditing: false,
    });
  });

  it('deletes before refreshing and clears an active selection only after persistence succeeds', async () => {
    const novel = testNovel();
    const harness = createBookWorkspaceTestHarness({ novel });
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ selectedNovel: novel, novels: [novel], view: 'chapters' }),
    );

    await controller.removeNovel(novel);

    expect(harness.calls).toEqual([
      'repository.deleteNovel',
      'adjacent.refreshNovels',
      'adjacent.refreshAfterLocalMutation',
      'environment.notify:info',
    ]);
    expect(controller.getSnapshot()).toMatchObject({ view: 'library', selectedNovel: undefined });
  });

  it('routes reset conflicts to sync refresh without projecting a cleared position', async () => {
    const conflict = new Error('conflict');
    const novel = testNovel({ lastReadChapterId: 'chapter-2', lastReadProgress: 0.5 });
    const position = testPosition();
    const harness = createBookWorkspaceTestHarness({ novel, position, conflict });
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ selectedNovel: novel, novels: [novel], localReadingPosition: position }),
    );

    await controller.resetBookProgress();

    expect(harness.calls).toEqual([
      'repository.clearReadingPosition',
      'environment.notify:warning',
      'adjacent.refreshSyncState',
    ]);
    expect(controller.getSnapshot().localReadingPosition).toBe(position);
  });

  it('refreshes reset projections only after the repository returns fresh book and position state', async () => {
    const previous = testNovel({ lastReadChapterId: 'chapter-2', lastReadProgress: 0.5 });
    const cleared = testNovel();
    const harness = createBookWorkspaceTestHarness({ novel: cleared });
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ selectedNovel: previous, novels: [previous], localReadingPosition: testPosition() }),
    );

    await controller.resetBookProgress();

    expect(harness.calls).toEqual([
      'repository.clearReadingPosition',
      'repository.getNovel',
      'repository.getReadingPosition',
      'adjacent.refreshNovels',
      'adjacent.refreshAfterLocalMutation',
      'environment.notify:success',
    ]);
    expect(controller.getSnapshot()).toMatchObject({ selectedNovel: cleared, localReadingPosition: undefined });
  });

  it('marks the highest indexed chapter finished and preserves progress mutation ordering', async () => {
    const activeNovel = testNovel({ lastReadProgress: 0.4 });
    const freshNovel = testNovel({ lastReadChapterId: 'chapter-3', lastReadProgress: 1 });
    const chapters = [testChapter(3), testChapter(1), testChapter(2)];
    const position = testPosition({ chapterId: 'chapter-3', chapterProgress: 1 });
    const harness = createBookWorkspaceTestHarness({ novel: freshNovel, chapters, position });
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ selectedNovel: activeNovel, novels: [activeNovel], chapters }),
    );

    await controller.markBookFinished();

    expect(harness.progressUpdates[0]).toEqual({
      novelId: 'book-1',
      chapterId: 'chapter-3',
      scrollTop: Number.MAX_SAFE_INTEGER,
      chapterProgress: 1,
      paragraphIndex: 10,
      offsetInParagraph: 0,
    });
    expect(harness.calls).toEqual([
      'repository.saveReadingPosition',
      'repository.getNovel',
      'repository.getReadingPosition',
      'adjacent.refreshNovels',
      'adjacent.refreshAfterLocalMutation',
      'environment.notify:success',
    ]);
    expect(controller.getSnapshot()).toMatchObject({ selectedNovel: freshNovel, localReadingPosition: position });
  });

  it('projects a saved fixed-document page locally and schedules only the progress mutation refresh', async () => {
    const novel = testNovel({ format: 'image_archive', activeContentRevisionId: 'revision-1' });
    const chapters = [testChapter(1), testChapter(2), testChapter(3)];
    const harness = createBookWorkspaceTestHarness({ novel, chapters });
    const refreshAfterLocalMutation = vi.fn(async (_kind?: 'progress' | 'statistics') => {
      harness.calls.push('adjacent.refreshAfterLocalMutation');
    });
    const refreshNovels = vi.fn(async () => {
      harness.calls.push('adjacent.refreshNovels');
    });
    const controller = new BookWorkspaceController(
      {
        ...harness.ports,
        adjacent: {
          ...harness.ports.adjacent,
          refreshAfterLocalMutation,
          refreshNovels,
        },
      },
      testWorkspaceState({ selectedNovel: novel, novels: [novel], chapters }),
    );

    await controller.saveFixedDocumentPage(1);

    expect(harness.progressUpdates).toEqual([
      {
        novelId: novel.id,
        expectedContentRevisionId: 'revision-1',
        chapterId: chapters[1]!.id,
        scrollTop: 1,
        chapterProgress: 1,
        paragraphIndex: 1,
        offsetInParagraph: 0,
      },
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      currentChapter: chapters[1],
      localReadingPosition: {
        chapterId: chapters[1]!.id,
        chapterProgress: 1,
        scrollTop: 1,
      },
      selectedNovel: {
        lastReadChapterId: chapters[1]!.id,
        lastReadChapterIndex: chapters[1]!.index,
        lastReadOffset: 1,
        lastReadProgress: 2 / 3,
      },
      novels: [
        {
          lastReadChapterId: chapters[1]!.id,
          lastReadChapterIndex: chapters[1]!.index,
          lastReadOffset: 1,
          lastReadProgress: 2 / 3,
        },
      ],
    });
    expect(refreshAfterLocalMutation).toHaveBeenCalledOnce();
    expect(refreshAfterLocalMutation).toHaveBeenCalledWith('progress');
    expect(refreshNovels).not.toHaveBeenCalled();
    expect(harness.calls).toEqual(['repository.saveReadingPosition', 'adjacent.refreshAfterLocalMutation']);
  });

  it('projects committed location and session time before scheduling adjacent refreshes', () => {
    const novel = testNovel();
    const chapter = testChapter(2);
    const harness = createBookWorkspaceTestHarness({ novel });
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ selectedNovel: novel, novels: [novel], chapters: [chapter], currentChapter: chapter }),
    );

    controller.commitLocation({
      novelId: novel.id,
      chapterId: chapter.id,
      location: {
        progress: 0.25,
        scrollTop: 120.6,
        paragraphIndex: 3,
        paragraph: {
          id: 'paragraph-3',
          novelId: novel.id,
          chapterId: chapter.id,
          index: 3,
          text: '문단',
          startOffsetInChapter: 20,
          endOffsetInChapter: 22,
          textHash: 'paragraph-hash',
        },
        ttsIndex: 2,
      },
      bookProgress: 0.42,
      updatedAt: '2026-07-11T02:00:00.000Z',
    });
    controller.setReaderSessionDisplaySeconds(90);
    controller.commitSessionTime(novel.id, 30, '2026-07-11T02:01:00.000Z');

    expect(controller.getSnapshot()).toMatchObject({
      readerProgress: 0.25,
      readerSessionDisplaySeconds: 90,
      readerSessionCommittedSeconds: 30,
      localReadingPosition: {
        chapterId: chapter.id,
        paragraphId: 'paragraph-3',
        scrollTop: 120.6,
      },
      selectedNovel: {
        lastReadOffset: 121,
        lastReadProgress: 0.42,
        readingSeconds: 30,
      },
    });
    expect(harness.calls).toEqual(['adjacent.refreshAfterLocalMutation', 'adjacent.refreshAfterLocalMutation']);
  });

  it('ignores a location commit emitted by a chapter that is no longer active', () => {
    const novel = testNovel();
    const currentChapter = testChapter(2);
    const harness = createBookWorkspaceTestHarness({ novel });
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ selectedNovel: novel, currentChapter, readerProgress: 0.6 }),
    );
    const before = controller.getSnapshot();

    controller.commitLocation({
      novelId: novel.id,
      chapterId: 'chapter-1',
      location: { progress: 0.2, scrollTop: 80, paragraphIndex: 2, ttsIndex: 1 },
      bookProgress: 0.1,
      updatedAt: '2026-07-11T02:02:00.000Z',
    });

    expect(controller.getSnapshot()).toBe(before);
    expect(harness.calls).toEqual([]);
  });

  it('does not publish a new snapshot or notify for same-value setters', () => {
    const harness = createBookWorkspaceTestHarness();
    const controller = new BookWorkspaceController(harness.ports);
    const listener = vi.fn();
    controller.subscribe(listener);
    const before = controller.getSnapshot();

    controller.setView('library');
    controller.setReaderMode('read');
    controller.setRemoteReadingPosition(undefined);

    expect(controller.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });
});
