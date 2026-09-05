import { describe, expect, it, vi } from 'vitest';
import { BookWorkspaceController } from './book-workspace-controller';
import { selectContinueChapter } from './book-workspace-projection';
import {
  createBookWorkspaceTestHarness,
  testChapter,
  testNovel,
  testPosition,
  testWorkspaceState,
} from './book-workspace-test-fixtures';

describe('BookWorkspaceController navigation', () => {
  it('keeps the newest book selection when an older load resolves last', async () => {
    const firstNovel = testNovel({ id: 'book-1', title: '첫 책' });
    const secondNovel = testNovel({ id: 'book-2', title: '둘째 책' });
    const firstChapter = testChapter(1, { id: 'book-1-chapter', novelId: firstNovel.id });
    const secondChapter = testChapter(1, { id: 'book-2-chapter', novelId: secondNovel.id });
    let resolveFirst: ((chapters: (typeof firstChapter)[]) => void) | undefined;
    const firstChapters = new Promise<(typeof firstChapter)[]>((resolve) => {
      resolveFirst = resolve;
    });
    const harness = createBookWorkspaceTestHarness();
    harness.ports.repository.listChapters = vi.fn((novelId) =>
      novelId === firstNovel.id ? firstChapters : Promise.resolve([secondChapter]),
    );

    const controller = new BookWorkspaceController(harness.ports);
    const firstOpen = controller.openNovel(firstNovel);
    await controller.openNovel(secondNovel);
    resolveFirst?.([firstChapter]);
    await firstOpen;

    expect(controller.getSnapshot()).toMatchObject({
      selectedNovel: secondNovel,
      chapters: [secondChapter],
      view: 'chapters',
    });
    expect(harness.calls.filter((call) => call === 'adjacent.applyBookAnnotations')).toHaveLength(1);
  });

  it('does not enter a stale chapter after a newer chapter finishes loading', async () => {
    const novel = testNovel();
    const firstChapter = testChapter(1);
    const secondChapter = testChapter(2);
    let resolveFirst: (() => void) | undefined;
    const firstArtifacts = new Promise<{ segments: []; characters: []; voiceProfiles: [] }>((resolve) => {
      resolveFirst = () => resolve({ segments: [], characters: [], voiceProfiles: [] });
    });
    const harness = createBookWorkspaceTestHarness({ novel, chapters: [firstChapter, secondChapter] });
    harness.ports.adjacent.loadReaderArtifacts = vi.fn((chapterId) => {
      harness.calls.push(`adjacent.loadReaderArtifacts:${chapterId}`);
      return chapterId === firstChapter.id
        ? firstArtifacts
        : Promise.resolve({ segments: [], characters: [], voiceProfiles: [] });
    });
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ selectedNovel: novel, chapters: [firstChapter, secondChapter], view: 'chapters' }),
    );

    const firstOpen = controller.openChapter(firstChapter);
    await Promise.resolve();
    await controller.openChapter(secondChapter);
    resolveFirst?.();
    await firstOpen;

    expect(controller.getSnapshot()).toMatchObject({ currentChapter: secondChapter, view: 'reader' });
    expect(harness.calls).not.toContain(`transition.activateChapter:${firstChapter.id}`);
  });

  it('invalidates delayed continue-reading data when sync replaces the same book selection', async () => {
    const novel = testNovel({ lastReadChapterId: 'chapter-1' });
    const chapters = [testChapter(1), testChapter(2)];
    const stalePosition = testPosition({ chapterId: 'chapter-1' });
    const currentPosition = testPosition({ chapterId: 'chapter-2', updatedAt: '2026-07-11T03:00:00.000Z' });
    let resolvePosition: ((position: typeof stalePosition) => void) | undefined;
    const delayedPosition = new Promise<typeof stalePosition>((resolve) => {
      resolvePosition = resolve;
    });
    const harness = createBookWorkspaceTestHarness({ novel, chapters });
    harness.ports.repository.getReadingPosition = vi.fn(() => delayedPosition);
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ selectedNovel: novel, novels: [novel], chapters, view: 'chapters' }),
    );

    const pendingContinue = controller.continueReading();
    controller.replaceSelection({ selectedNovel: { ...novel }, chapters, localReadingPosition: currentPosition });
    resolvePosition?.(stalePosition);
    await pendingContinue;

    expect(controller.getSnapshot().localReadingPosition).toBe(currentPosition);
    expect(controller.getSnapshot().currentChapter).toBeUndefined();
  });

  it('does not reopen a deleted book when its earlier load resolves late', async () => {
    const novel = testNovel();
    const chapter = testChapter(1);
    let resolveChapters: ((chapters: (typeof chapter)[]) => void) | undefined;
    const delayedChapters = new Promise<(typeof chapter)[]>((resolve) => {
      resolveChapters = resolve;
    });
    const harness = createBookWorkspaceTestHarness({ novel });
    harness.ports.repository.listChapters = vi.fn(() => delayedChapters);
    const controller = new BookWorkspaceController(harness.ports);

    const pendingOpen = controller.openNovel(novel);
    await controller.removeNovel(novel);
    resolveChapters?.([chapter]);
    await pendingOpen;

    expect(controller.getSnapshot()).toMatchObject({ chapters: [], view: 'library' });
    expect(controller.getSnapshot().selectedNovel).toBeUndefined();
  });

  it('prioritizes the persisted reading position, then novel metadata, then the first chapter', () => {
    const chapters = [testChapter(1), testChapter(2), testChapter(3)];
    const novel = testNovel({ lastReadChapterId: 'chapter-3' });

    expect(selectContinueChapter(chapters, novel, testPosition({ chapterId: 'chapter-2' }))?.id).toBe('chapter-2');
    expect(selectContinueChapter(chapters, novel, testPosition({ chapterId: 'missing' }))?.id).toBe('chapter-3');
    expect(selectContinueChapter(chapters, testNovel(), undefined)?.id).toBe('chapter-1');
  });

  it('opens a logical comic release at its first fixed-document page', async () => {
    const novel = testNovel({ format: 'image_archive', documentSectionCount: 2 });
    const chapters = [
      testChapter(1, { documentSectionId: 'chapter:11', documentSectionTitle: '01화' }),
      testChapter(2, { documentSectionId: 'chapter:11', documentSectionTitle: '01화' }),
      testChapter(3, { documentSectionId: 'chapter:12', documentSectionTitle: '02화' }),
      testChapter(4, { documentSectionId: 'chapter:12', documentSectionTitle: '02화' }),
    ];
    const harness = createBookWorkspaceTestHarness({
      novel,
      chapters,
      position: testPosition({ chapterId: 'chapter-1' }),
    });
    const controller = new BookWorkspaceController(harness.ports);

    await controller.openDocumentSection(novel, 'chapter:12');

    expect(controller.getSnapshot()).toMatchObject({
      view: 'document',
      selectedNovel: novel,
      currentChapter: chapters[2],
      fixedDocumentOpenChapterId: chapters[2]?.id,
    });
  });

  it('opens a legacy self-host comic release by its preserved page-title prefix', async () => {
    const novel = testNovel({ format: 'image_archive' });
    const chapters = [
      testChapter(1, { title: '01화 · 1페이지' }),
      testChapter(2, { title: '01화 · 2페이지' }),
      testChapter(3, { title: '02화 · 1페이지' }),
      testChapter(4, { title: '02화 · 2페이지' }),
    ];
    const harness = createBookWorkspaceTestHarness({
      novel,
      chapters,
      position: testPosition({ chapterId: chapters[0]!.id }),
    });
    const controller = new BookWorkspaceController(harness.ports);

    await controller.openDocumentSection(novel, 'chapter:12', '02화');

    expect(controller.getSnapshot()).toMatchObject({
      view: 'document',
      currentChapter: chapters[2],
      fixedDocumentOpenChapterId: chapters[2]?.id,
    });
  });

  it('opens the selected TXT release through the Reader lifecycle instead of the general chapter list', async () => {
    const novel = testNovel({ format: 'txt', documentSectionCount: 2, lastReadChapterId: 'chapter-1' });
    const chapters = [
      testChapter(1, { documentSectionId: 'release-one', documentSectionTitle: '같은 제목' }),
      testChapter(2, { documentSectionId: 'release-two', documentSectionTitle: '같은 제목' }),
    ];
    const harness = createBookWorkspaceTestHarness({
      novel,
      chapters,
      position: testPosition({ chapterId: 'chapter-1' }),
    });
    const controller = new BookWorkspaceController(harness.ports);
    await controller.openDocumentSection(novel, 'release-two', '같은 제목');
    expect(controller.getSnapshot()).toMatchObject({
      view: 'reader',
      currentChapter: chapters[1],
      readerOpenRequestVersion: 7,
    });
    expect(harness.preparedOpens).toEqual([
      { chapterId: 'chapter-2', options: expect.objectContaining({ restore: false, fallbackScrollTop: 0 }) },
    ]);
    expect(harness.calls).toContain('adjacent.loadReaderArtifacts:chapter-2');
    expect(harness.calls).toContain('transition.activateChapter:chapter-2');
  });

  it('does not guess a TXT release by title when its stable section is missing', async () => {
    const novel = testNovel({ format: 'txt', documentSectionCount: 1 });
    const harness = createBookWorkspaceTestHarness({
      novel,
      chapters: [testChapter(1, { documentSectionId: 'one', documentSectionTitle: '같은 제목' })],
    });
    const controller = new BookWorkspaceController(harness.ports);
    await controller.openDocumentSection(novel, 'missing', '같은 제목');
    expect(controller.getSnapshot().view).toBe('chapters');
    expect(harness.preparedOpens).toEqual([]);
    expect(harness.notices[0]?.message).toContain('선택한 회차를 찾을 수 없습니다');
  });

  it.each(['chapters', 'artifacts'] as const)(
    'does not open a cancelled TXT release after delayed %s resolve',
    async (stage) => {
      const novel = testNovel({ format: 'txt', documentSectionCount: 1 });
      const chapter = testChapter(1, { documentSectionId: 'release-one' });
      const harness = createBookWorkspaceTestHarness({ novel, chapters: [chapter] });
      let finish!: () => void;
      if (stage === 'chapters')
        harness.ports.repository.listChapters = () =>
          new Promise((resolve) => {
            finish = () => resolve([chapter]);
          });
      else
        harness.ports.adjacent.loadReaderArtifacts = () =>
          new Promise((resolve) => {
            finish = () => resolve({ segments: [], characters: [], voiceProfiles: [] });
          });
      const controller = new BookWorkspaceController(harness.ports);
      const pending = controller.openDocumentSection(novel, 'release-one');
      await vi.waitFor(() => expect(finish).toBeDefined());
      const newer = testNovel({ id: 'new-book' });
      controller.replaceSelection({ selectedNovel: newer, chapters: [], currentChapter: undefined });
      controller.setView('library');
      finish();
      await pending;
      expect(controller.getSnapshot()).toMatchObject({
        selectedNovel: newer,
        view: 'library',
        currentChapter: undefined,
      });
      expect(harness.preparedOpens).toEqual([]);
    },
  );

  it('preserves the openChapter lifecycle ordering and prepares restore metadata before entering reader view', async () => {
    const novel = testNovel({ lastReadChapterId: 'chapter-2', lastReadOffset: 480 });
    const chapter = testChapter(2);
    const position = testPosition();
    const harness = createBookWorkspaceTestHarness({ novel, chapters: [chapter], position });
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ selectedNovel: novel, novels: [novel], chapters: [chapter], view: 'chapters' }),
    );

    await controller.openChapter(chapter, {
      restore: true,
      novel,
      position,
      preserveSearch: true,
      targetParagraphId: 'paragraph-4',
      initialMode: 'correction',
    });

    expect(harness.calls).toEqual([
      'transition.flushReaderSession',
      'transition.resetAnalysis',
      'transition.stopChapterTTS',
      'adjacent.loadReaderArtifacts:chapter-2',
      'transition.activateChapter:chapter-2',
      'transition.prepareReaderOpen:chapter-2',
      'adjacent.applyReaderArtifacts',
      'adjacent.resetCorrection',
      'adjacent.resetAnnotationEditor',
    ]);
    expect(harness.preparedOpens[0]).toEqual({
      chapterId: 'chapter-2',
      options: {
        restore: true,
        position,
        fallbackScrollTop: 480,
        preserveSearch: true,
        targetParagraphId: 'paragraph-4',
        initialMode: 'correction',
      },
    });
    expect(controller.getSnapshot()).toMatchObject({
      view: 'reader',
      currentChapter: chapter,
      readerMode: 'read',
      readerProgress: 0,
      readerSessionDisplaySeconds: 0,
      readerSessionCommittedSeconds: 0,
      readerOpenRequestVersion: 7,
    });
  });

  it('continues from the persisted chapter without reloading an already selected chapter list', async () => {
    const novel = testNovel({ lastReadChapterId: 'chapter-3' });
    const chapters = [testChapter(1), testChapter(2), testChapter(3)];
    const position = testPosition({ chapterId: 'chapter-2' });
    const harness = createBookWorkspaceTestHarness({ novel, chapters, position });
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ selectedNovel: novel, novels: [novel], chapters, view: 'chapters' }),
    );

    await controller.continueReading();

    expect(harness.calls.slice(0, 2)).toEqual(
      expect.arrayContaining(['repository.getNovel', 'repository.getReadingPosition']),
    );
    expect(harness.calls).not.toContain('repository.listChapters');
    expect(controller.getSnapshot().currentChapter?.id).toBe('chapter-2');
    expect(controller.getSnapshot().localReadingPosition).toBe(position);
  });

  it('flushes the last read position before returning to chapters', async () => {
    const harness = createBookWorkspaceTestHarness();
    const controller = new BookWorkspaceController(harness.ports, testWorkspaceState({ view: 'reader' }));

    await controller.returnToChapters();

    expect(harness.calls).toEqual(['transition.stopReaderTTS', 'transition.flushReaderSession']);
    expect(controller.getSnapshot().view).toBe('chapters');
  });
});
