import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Chapter, Novel } from '../../domain/types';
import { buildLibraryBookView } from '../library/library-screen-model';
import { ChaptersScreen, type ChaptersScreenActions, type ChaptersScreenModel } from './ChaptersScreen';
import { buildChapterListModel } from './chapters-screen-model';

type HostElement = ReactElement<Record<string, unknown>, string>;

function collectHostElements(node: ReactNode): HostElement[] {
  if (Array.isArray(node)) return node.flatMap(collectHostElements);
  if (!isValidElement(node)) return [];

  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === 'function') {
    const Component = element.type as (props: Record<string, unknown>) => ReactNode;
    return collectHostElements(Component(element.props));
  }

  const children = collectHostElements(element.props.children as ReactNode);
  return typeof element.type === 'string' ? [element as HostElement, ...children] : children;
}

function novel(): Novel {
  return {
    id: 'novel-1',
    title: '화면 테스트 소설',
    sourceFileName: 'chapters.txt',
    sourceEncoding: 'utf-8',
    rawText: '본문',
    normalizedText: '본문',
    rawTextHash: 'raw-hash',
    normalizedTextHash: 'normalized-hash',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    totalChapters: 2,
    totalCharacters: 2400,
    totalParagraphs: 40,
    coverSeed: 4,
    lastReadChapterId: 'chapter-2',
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
    titleEditor: {
      start: vi.fn(),
      cancel: vi.fn(),
      setDraft: vi.fn(),
      save: vi.fn(),
    },
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
    chapterList: {
      setQuery: vi.fn(),
      setReadFilter: vi.fn(),
      setSort: vi.fn(),
      openChapter,
    },
  };
}

function createModel(chapters: Chapter[]): ChaptersScreenModel {
  const currentChapter = chapters[1];
  return {
    book: buildLibraryBookView(novel(), {
      hasReadActivity: () => true,
      isFinished: () => false,
    }),
    titleEditor: { editing: false, draft: '화면 테스트 소설' },
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
      readLocationLabel: '2. 2화 제목',
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

describe('ChaptersScreen', () => {
  it('renders chapter state and annotation presentation from the pure list model', () => {
    const screenModel = createModel([chapter(1), chapter(2)]);
    const markup = renderToStaticMarkup(<ChaptersScreen model={screenModel} actions={createActions()} />);

    expect(markup).toContain('화면 테스트 소설');
    expect(markup).toContain('1화 제목');
    expect(markup).toContain('2화 제목');
    expect(markup).toContain('북마크 1');
    expect(markup).toContain('메모 1');
    expect(markup).toContain('chapter-row is-read');
    expect(markup).toContain('chapter-row is-current');
  });

  it('wires back navigation and chapter selection with the current-row restore flag', () => {
    const chapters = [chapter(1), chapter(2)];
    const backToLibrary = vi.fn();
    const openChapter = vi.fn();
    const props = {
      model: createModel(chapters),
      actions: createActions(backToLibrary, openChapter),
    };
    const hostElements = collectHostElements(ChaptersScreen(props));
    const backButton = hostElements.find((element) => element.type === 'button' && element.props.title === '책장으로');
    const chapterRows = hostElements.filter(
      (element) => element.type === 'button' && String(element.props.className).includes('chapter-row'),
    );

    expect(backButton).toBeDefined();
    expect(chapterRows).toHaveLength(2);

    (backButton!.props.onClick as () => void)();
    (chapterRows[0].props.onClick as () => void)();
    (chapterRows[1].props.onClick as () => void)();

    expect(backToLibrary).toHaveBeenCalledOnce();
    expect(openChapter).toHaveBeenNthCalledWith(1, chapters[0], false);
    expect(openChapter).toHaveBeenNthCalledWith(2, chapters[1], true);
  });

  it('exposes accessible names and selected or current states on chapter controls', () => {
    const props = {
      model: createModel([chapter(1), chapter(2), chapter(3)]),
      actions: createActions(),
    };
    const hostElements = collectHostElements(ChaptersScreen(props));
    const searchInput = hostElements.find(
      (element) => element.type === 'input' && element.props['aria-label'] === '화 검색',
    );
    const controlGroups = hostElements.filter((element) => element.type === 'div' && element.props.role === 'group');
    const pressedButtons = hostElements.filter(
      (element) => element.type === 'button' && element.props['aria-pressed'] === true,
    );
    const chapterRows = hostElements.filter(
      (element) => element.type === 'button' && String(element.props.className).includes('chapter-row'),
    );
    const titleEditButton = hostElements.find(
      (element) => element.type === 'button' && element.props['aria-controls'] === 'book-title-editor',
    );

    expect(searchInput?.props.type).toBe('search');
    expect(controlGroups.map((group) => group.props['aria-label'])).toEqual(['읽은 상태 필터', '화 정렬']);
    expect(pressedButtons).toHaveLength(2);
    expect(titleEditButton?.props['aria-expanded']).toBe(false);
    expect(chapterRows[0].props['aria-current']).toBeUndefined();
    expect(chapterRows[0].props['aria-label']).toContain('읽음');
    expect(chapterRows[0].props['aria-label']).toContain('북마크 1');
    expect(chapterRows[1].props['aria-current']).toBe('location');
    expect(chapterRows[1].props['aria-label']).toContain('현재 읽는 화');
    expect(chapterRows[2].props['aria-label']).toContain('안 읽음');
  });

  it('places the compact book action surface before the chapter list', () => {
    const markup = renderToStaticMarkup(
      <ChaptersScreen model={createModel([chapter(1), chapter(2)])} actions={createActions()} />,
    );
    const actionSurface = markup.indexOf('reader-summary reader-summary-mobile');
    const chapterList = markup.indexOf('class="chapter-layout"');

    expect(actionSurface).toBeGreaterThan(-1);
    expect(actionSurface).toBeLessThan(chapterList);
    expect(markup).toContain('책 정보 및 작업');
    expect(markup).toContain('읽은 위치 초기화');
  });
});
