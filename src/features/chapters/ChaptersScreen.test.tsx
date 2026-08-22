import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chapter, Novel } from '../../domain/types';
import { buildLibraryBookView } from '../library/library-screen-model';
import { buildChapterListModel } from './chapters-screen-model';
import { ChaptersScreen, type ChaptersScreenActions, type ChaptersScreenModel } from './ChaptersScreen';

let renderer: ReactTestRenderer | undefined;

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

function novel(totalChapters = 2): Novel {
  return {
    id: 'novel-1',
    format: 'epub',
    title: '화면 테스트 소설',
    author: '테스트 작가',
    seriesTitle: '테스트 시리즈',
    description: '표지와 회차 표시를 검증하는 작품 소개',
    tags: ['판타지', '모험'],
    sourceFileName: 'chapters.epub',
    sourceEncoding: 'utf-8',
    rawText: '본문',
    normalizedText: '본문',
    rawTextHash: 'raw-hash',
    normalizedTextHash: 'normalized-hash',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    totalChapters,
    totalCharacters: totalChapters * 1200,
    totalParagraphs: totalChapters * 20,
    coverSeed: 4,
    lastReadChapterId: 'chapter-2',
    lastReadChapterIndex: 2,
    lastReadOffset: 0,
    lastReadProgress: 0.6,
    readingSeconds: 600,
    lastReadAt: '2026-07-09T12:00:00.000Z',
    favorite: false,
    analysisStatus: 'not_analyzed',
  };
}

function chapter(index: number): Chapter {
  return {
    id: `chapter-${index}`,
    novelId: 'novel-1',
    index,
    title: `${index}화 제목`,
    normalizedText: `본문 ${index}`,
    textHash: `chapter-hash-${index}`,
    rawStartOffset: (index - 1) * 100,
    rawEndOffset: index * 100,
    characterCount: index * 1000,
    paragraphCount: index * 10,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function createActions(backToLibrary = vi.fn(), openChapter = vi.fn()): ChaptersScreenActions {
  return {
    navigation: {
      backToLibrary,
      continueReading: vi.fn(),
      openSettings: vi.fn(),
      openSync: vi.fn(),
      openImport: vi.fn(),
      openStructureEditor: vi.fn(),
      openMetadata: vi.fn(),
    },
    titleEditor: { start: vi.fn(), cancel: vi.fn(), setDraft: vi.fn(), save: vi.fn() },
    book: {
      toggleFavorite: vi.fn(),
      openFirstUnreadChapter: vi.fn(),
      markCurrentChapterRead: vi.fn(),
      markFinished: vi.fn(),
      resetProgress: vi.fn(),
      exportSource: vi.fn(),
      reselectSource: vi.fn(),
      reconstructSource: vi.fn(),
    },
    chapterList: { setQuery: vi.fn(), setReadFilter: vi.fn(), setSort: vi.fn(), openChapter },
  };
}

function createModel(chapters: Chapter[], currentIndex = 2): ChaptersScreenModel {
  const sourceNovel = novel(chapters.length);
  sourceNovel.lastReadChapterId = `chapter-${currentIndex}`;
  sourceNovel.lastReadChapterIndex = currentIndex;
  const currentChapter = chapters.find((item) => item.index === currentIndex);
  return {
    book: buildLibraryBookView(sourceNovel, { hasReadActivity: () => true, isFinished: () => false }),
    titleEditor: { editing: false, draft: sourceNovel.title },
    query: '',
    readFilter: 'all',
    sort: 'asc',
    chapterList: buildChapterListModel({
      chapters,
      query: '',
      readFilter: 'all',
      sort: 'asc',
      currentChapter,
      annotationCounts: new Map([['chapter-1', { bookmarks: 1, highlights: 0, notes: 1 }]]),
    }),
    summary: {
      readChapterProgress: 0.2,
      readLocationLabel: `${currentIndex}. ${currentIndex}화 제목`,
      bookmarkCount: 1,
      highlightCount: 0,
      noteCount: 1,
      syncLabel: '로컬',
      firstUnreadChapter: currentChapter,
      currentReadTargetChapter: currentChapter,
      canMarkCurrentChapterRead: true,
      canMarkBookFinished: true,
      canResetBookProgress: true,
    },
  };
}

function renderScreen(model: ChaptersScreenModel, actions = createActions()): ReactTestInstance {
  act(() => {
    renderer = create(<ChaptersScreen model={model} actions={actions} />);
  });
  return renderer!.root;
}

function buttonByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.findAllByType('button').find((button) => button.props['aria-label'] === label)!;
}

describe('ChaptersScreen', () => {
  it('renders the native detail hero and production metadata', () => {
    const markup = renderToStaticMarkup(
      <ChaptersScreen model={createModel([chapter(1), chapter(2)])} actions={createActions()} />,
    );
    expect(markup).toContain('book-detail-hero');
    expect(markup).toContain('화면 테스트 소설');
    expect(markup).toContain('테스트 작가');
    expect(markup).toContain('#판타지');
    expect(markup).toContain('누적 독서 시간');
    expect(markup).toContain('60%');
  });

  it('uses the whole-book projection for detail percentages and keeps chapter progress on the current row', () => {
    const screenModel = createModel([chapter(1), chapter(2)]);
    screenModel.book = { ...screenModel.book, bookProgress: 0.42 };
    const markup = renderToStaticMarkup(<ChaptersScreen model={screenModel} actions={createActions()} />);

    expect(markup).toContain('aria-valuenow="42"');
    expect(markup).toContain('전체 진행률</dt><dd>42%');
    expect(markup).not.toContain('전체 진행률</dt><dd>60%');
    expect(markup).toContain('현재 읽는 화, 20% 진행');
  });

  it('wires back navigation and chapter selection with the current-row restore flag', () => {
    const chapters = [chapter(1), chapter(2)];
    const backToLibrary = vi.fn();
    const openChapter = vi.fn();
    const root = renderScreen(createModel(chapters), createActions(backToLibrary, openChapter));
    const rows = root
      .findAllByType('button')
      .filter((button) => String(button.props.className).includes('chapter-row'));

    root.findByProps({ className: 'detail-back-button' }).props.onClick();
    rows[0].props.onClick();
    rows[1].props.onClick();

    expect(backToLibrary).toHaveBeenCalledOnce();
    expect(openChapter).toHaveBeenNthCalledWith(1, chapters[0], false);
    expect(openChapter).toHaveBeenNthCalledWith(2, chapters[1], true);
  });

  it('exposes selected, current and metadata semantics on chapter controls', () => {
    const root = renderScreen(createModel([chapter(1), chapter(2), chapter(3)]));
    const rows = root
      .findAllByType('button')
      .filter((button) => String(button.props.className).includes('chapter-row'));
    const pressed = root.findAllByType('button').filter((button) => button.props['aria-pressed'] === true);

    expect(root.findByProps({ 'aria-label': '화 검색' }).props.type).toBe('search');
    expect(pressed).toHaveLength(1);
    expect(rows[0].props['aria-label']).toContain('읽음');
    expect(rows[0].props['aria-label']).toContain('북마크 1');
    expect(rows[1].props['aria-current']).toBe('location');
    expect(rows[1].props['aria-label']).toContain('현재 읽는 화');
    expect(rows[1].props['aria-label']).toContain('TTS 예상');
    expect(rows[2].props['aria-label']).toContain('안 읽음');
  });

  it('keeps advanced production actions in a disclosure before the chapter panel', () => {
    const markup = renderToStaticMarkup(
      <ChaptersScreen model={createModel([chapter(1), chapter(2)])} actions={createActions()} />,
    );
    expect(markup.indexOf('book-management-disclosure')).toBeLessThan(markup.indexOf('chapter-panel'));
    expect(markup).toContain('작품 관리 및 파일 정보');
    expect(markup).toContain('원본 다운로드');
    expect(markup).toContain('읽은 위치 초기화');
  });

  it('starts on the ten-row page containing the current chapter', () => {
    const chapters = Array.from({ length: 25 }, (_, index) => chapter(index + 1));
    const root = renderScreen(createModel(chapters, 12));
    const rows = root
      .findAllByType('button')
      .filter((button) => String(button.props.className).includes('chapter-row'));

    expect(rows).toHaveLength(10);
    expect(rows[0].props['aria-label']).toContain('11화');
    expect(rows[9].props['aria-label']).toContain('20화');
    expect(buttonByLabel(root, '2페이지').props['aria-current']).toBe('page');
  });

  it('moves between pages without changing production chapter actions', () => {
    const chapters = Array.from({ length: 25 }, (_, index) => chapter(index + 1));
    const root = renderScreen(createModel(chapters, 12));

    act(() => buttonByLabel(root, '3페이지').props.onClick());

    const rows = root
      .findAllByType('button')
      .filter((button) => String(button.props.className).includes('chapter-row'));
    expect(rows).toHaveLength(5);
    expect(rows[0].props['aria-label']).toContain('21화');
    expect(buttonByLabel(root, '3페이지').props['aria-current']).toBe('page');
  });

  it('returns to page one when a filter is selected', () => {
    const chapters = Array.from({ length: 25 }, (_, index) => chapter(index + 1));
    const actions = createActions();
    const root = renderScreen(createModel(chapters, 12), actions);
    const allButton = root.findAllByType('button').find((button) => button.props.children === '전체')!;

    act(() => allButton.props.onClick());

    const rows = root
      .findAllByType('button')
      .filter((button) => String(button.props.className).includes('chapter-row'));
    expect(actions.chapterList.setReadFilter).toHaveBeenCalledWith('all');
    expect(rows[0].props['aria-label']).toContain('1화');
    expect(buttonByLabel(root, '1페이지').props['aria-current']).toBe('page');
  });
});
