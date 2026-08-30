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
    const completeBookAssociationPurge = vi.fn(async () => {
      harness.calls.push('associationLifecycle.completeBookAssociationPurge');
    });
    const prepareBookAssociationPurge = vi.fn(async () => ({ id: 'purge-intent-1' }));
    const controller = new BookWorkspaceController(
      {
        ...harness.ports,
        associationLifecycle: { prepareBookAssociationPurge, completeBookAssociationPurge },
      },
      testWorkspaceState({ selectedNovel: novel, novels: [novel], view: 'chapters' }),
    );

    await controller.removeNovel(novel);

    expect(harness.calls).toEqual([
      'repository.deleteNovel',
      'adjacent.refreshNovels',
      'adjacent.refreshAfterLocalMutation',
      'environment.notify:info',
    ]);
    expect(completeBookAssociationPurge).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ view: 'library', selectedNovel: undefined });
  });

  it('removes external-source bindings only after a permanent purge succeeds', async () => {
    const novel = testNovel({ deletedAt: '2026-08-29T00:00:00.000Z' });
    const harness = createBookWorkspaceTestHarness({ novel });
    const completeBookAssociationPurge = vi.fn(async (_intentId: string, bookIds?: readonly string[]) => {
      harness.calls.push(`associationLifecycle.completeBookAssociationPurge:${bookIds?.join(',')}`);
    });
    const prepareBookAssociationPurge = vi.fn(async () => {
      harness.calls.push('associationLifecycle.prepareBookAssociationPurge');
      return { id: 'purge-intent-1' };
    });
    const controller = new BookWorkspaceController(
      {
        ...harness.ports,
        catalog: {
          listTrash: async () => [novel],
          restore: async () => undefined,
          purge: async () => {
            harness.calls.push('catalog.purge');
          },
          emptyTrash: async () => ({ purged: 0, bookIds: [] }),
        },
        associationLifecycle: { prepareBookAssociationPurge, completeBookAssociationPurge },
      },
      testWorkspaceState({ novels: [novel] }),
    );

    await controller.purgeNovel(novel);

    expect(harness.calls).toEqual([
      'associationLifecycle.prepareBookAssociationPurge',
      'catalog.purge',
      'associationLifecycle.completeBookAssociationPurge:book-1',
      'adjacent.refreshNovels',
      'adjacent.refreshAfterLocalMutation',
      'environment.notify:info',
    ]);
    expect(prepareBookAssociationPurge).toHaveBeenCalledWith([
      { bookId: 'book-1', activeContentRevisionId: novel.activeContentRevisionId },
    ]);
    expect(completeBookAssociationPurge).toHaveBeenCalledWith('purge-intent-1', ['book-1']);
  });

  it('removes bindings only for the exact book ids acknowledged by empty-trash', async () => {
    const first = testNovel({ id: 'trash-1', deletedAt: '2026-08-29T00:00:00.000Z' });
    const second = testNovel({ id: 'trash-2', deletedAt: '2026-08-29T00:01:00.000Z' });
    const harness = createBookWorkspaceTestHarness();
    const completeBookAssociationPurge = vi.fn(async (_intentId: string, bookIds?: readonly string[]) => {
      harness.calls.push(`associationLifecycle.completeBookAssociationPurge:${bookIds?.join(',')}`);
    });
    const prepareBookAssociationPurge = vi.fn(async () => {
      harness.calls.push('associationLifecycle.prepareBookAssociationPurge');
      return { id: 'purge-intent-1' };
    });
    const controller = new BookWorkspaceController({
      ...harness.ports,
      catalog: {
        listTrash: async () => {
          harness.calls.push('catalog.listTrash');
          return [first, second];
        },
        restore: async () => undefined,
        purge: async () => undefined,
        emptyTrash: async () => {
          harness.calls.push('catalog.emptyTrash');
          return { purged: 2, bookIds: ['trash-1', 'trash-2'] };
        },
      },
      associationLifecycle: { prepareBookAssociationPurge, completeBookAssociationPurge },
    });

    await controller.emptyTrash();

    expect(harness.calls).toEqual([
      'catalog.listTrash',
      'associationLifecycle.prepareBookAssociationPurge',
      'catalog.emptyTrash',
      'associationLifecycle.completeBookAssociationPurge:trash-1,trash-2',
      'adjacent.refreshNovels',
      'adjacent.refreshAfterLocalMutation',
      'environment.notify:info',
    ]);
    expect(prepareBookAssociationPurge).toHaveBeenCalledWith([
      { bookId: 'trash-1', activeContentRevisionId: first.activeContentRevisionId },
      { bookId: 'trash-2', activeContentRevisionId: second.activeContentRevisionId },
    ]);
    expect(completeBookAssociationPurge).toHaveBeenCalledWith('purge-intent-1', ['trash-1', 'trash-2']);
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

  it('projects a saved fixed-document page and its exact section marker before the background refresh', async () => {
    const novel = testNovel({ format: 'image_archive', activeContentRevisionId: 'revision-1' });
    const chapters = [
      testChapter(1, { documentSectionId: 'chapter:1' }),
      testChapter(2, { documentSectionId: 'chapter:2' }),
      testChapter(3, { documentSectionId: 'chapter:2' }),
    ];
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
        documentSectionId: 'chapter:2',
        scrollTop: 1,
        chapterProgress: 1,
        paragraphIndex: 1,
        offsetInParagraph: 0,
      },
    ]);
    const snapshot = controller.getSnapshot();
    expect(snapshot).toMatchObject({
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
    const exactSectionReadAt = snapshot.chapters[1]?.documentSectionReadAt;
    expect(exactSectionReadAt).toBeDefined();
    expect(snapshot.currentChapter?.documentSectionReadAt).toBe(exactSectionReadAt);
    expect(snapshot.chapters[0]?.documentSectionReadAt).toBeUndefined();
    expect(snapshot.chapters[2]?.documentSectionReadAt).toBe(exactSectionReadAt);
    expect(refreshAfterLocalMutation).toHaveBeenCalledOnce();
    expect(refreshAfterLocalMutation).toHaveBeenCalledWith('progress');
    expect(refreshNovels).not.toHaveBeenCalled();
    expect(harness.calls).toEqual(['repository.saveReadingPosition', 'adjacent.refreshAfterLocalMutation']);
  });

  it('does not let a delayed fixed-document write restore the previously open book', async () => {
    const firstNovel = testNovel({ id: 'book-1', format: 'image_archive', activeContentRevisionId: 'revision-1' });
    const secondNovel = testNovel({ id: 'book-2', format: 'image_archive', activeContentRevisionId: 'revision-2' });
    const firstChapters = [testChapter(1, { novelId: firstNovel.id, documentSectionId: 'first:1' })];
    const secondChapters = [testChapter(1, { novelId: secondNovel.id, documentSectionId: 'second:1' })];
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const harness = createBookWorkspaceTestHarness({ novel: firstNovel, chapters: firstChapters });
    const controller = new BookWorkspaceController(
      {
        ...harness.ports,
        repository: {
          ...harness.ports.repository,
          saveReadingPosition: async (input) => {
            harness.progressUpdates.push(input);
            await saveGate;
          },
        },
      },
      testWorkspaceState({ selectedNovel: firstNovel, novels: [firstNovel, secondNovel], chapters: firstChapters }),
    );

    const pendingSave = controller.saveFixedDocumentPage(0);
    controller.replaceSelection({
      selectedNovel: secondNovel,
      chapters: secondChapters,
      currentChapter: secondChapters[0],
    });
    releaseSave();
    await pendingSave;

    expect(harness.progressUpdates[0]).toMatchObject({
      novelId: firstNovel.id,
      expectedContentRevisionId: firstNovel.activeContentRevisionId,
      chapterId: firstChapters[0]!.id,
    });
    expect(controller.getSnapshot()).toMatchObject({
      selectedNovel: { id: secondNovel.id },
      currentChapter: { id: secondChapters[0]!.id },
    });
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
