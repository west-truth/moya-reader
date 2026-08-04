import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Novel } from '../../domain/types';
import { LibraryScreen, type LibraryScreenActions, type LibraryScreenModel } from './LibraryScreen';
import { buildLibraryCollectionModel, type NovelReadStateSelectors } from './library-screen-model';

type HostElement = ReactElement<Record<string, unknown>, string>;

function collectHostElements(node: ReactNode): HostElement[] {
  if (Array.isArray(node)) return node.flatMap(collectHostElements);
  if (!isValidElement(node)) return [];

  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === 'function') {
    const Component = element.type as (props: Record<string, unknown>) => ReactNode;
    if (Component.name === 'LibraryMobileMenu' || Component.name === 'LibraryInspector') return [];
    return collectHostElements(Component(element.props));
  }

  const children = collectHostElements(element.props.children as ReactNode);
  return typeof element.type === 'string' ? [element as HostElement, ...children] : children;
}

const readState: NovelReadStateSelectors = {
  hasReadActivity: (novel) =>
    Boolean(novel.lastReadAt || novel.lastReadProgress > 0 || (novel.readingSeconds ?? 0) > 0),
  isFinished: (novel) => novel.lastReadProgress >= 0.995,
};

function novel(overrides: Partial<Novel> = {}): Novel {
  return {
    id: 'novel-1',
    title: '테스트 소설',
    sourceFileName: 'test.txt',
    sourceEncoding: 'utf-8',
    rawText: '본문',
    normalizedText: '본문',
    rawTextHash: 'raw-hash',
    normalizedTextHash: 'normalized-hash',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    totalChapters: 2,
    totalCharacters: 1200,
    totalParagraphs: 20,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
    ...overrides,
  };
}

function actions(): LibraryScreenActions {
  return {
    drag: {
      enter: vi.fn(),
      over: vi.fn(),
      leave: vi.fn(),
      drop: vi.fn(),
      dropOnEmptyState: vi.fn(),
    },
    header: {
      setQuery: vi.fn(),
      retryBootstrap: vi.fn(),
      openSync: vi.fn(),
      openSettings: vi.fn(),
      openBackup: vi.fn(),
      openImport: vi.fn(),
      openLibraryFolders: vi.fn(),
    },
    presentation: {
      focusBook: vi.fn(),
      closeInspector: vi.fn(),
    },
    controls: {
      setFilter: vi.fn(),
      setSort: vi.fn(),
      setViewMode: vi.fn(),
      emptyTrash: vi.fn(),
      setShelf: vi.fn(),
      openShelves: vi.fn(),
      startSelection: vi.fn(),
      selectVisible: vi.fn(),
      clearSelection: vi.fn(),
      applyBatch: vi.fn(),
      exportSelectedMetadata: vi.fn(),
    },
    books: {
      open: vi.fn(),
      continueReading: vi.fn(),
      toggleFavorite: vi.fn(),
      remove: vi.fn(),
      restore: vi.fn(),
      purge: vi.fn(),
      downloadSource: vi.fn(),
      addSample: vi.fn(),
      editMetadata: vi.fn(),
      toggleSelected: vi.fn(),
    },
  };
}

function model(novels: Novel[], overrides: Partial<LibraryScreenModel> = {}): LibraryScreenModel {
  return {
    bootstrap: { status: 'ready' },
    drop: { active: false, importBusy: false },
    query: '',
    sync: { label: '로컬', tone: 'local' },
    filter: 'all',
    sort: 'recent',
    viewMode: 'grid',
    collection: buildLibraryCollectionModel({
      novels,
      query: '',
      filter: 'all',
      sort: 'recent',
      readState,
    }),
    presentation: {
      layoutMode: 'wide',
      focusedBookId: novels[0]?.id,
      inspectorOpen: true,
      shelfBookCounts: new Map(),
    },
    management: {
      available: true,
      shelves: [],
      selectionMode: false,
      selectedBookIds: new Set(),
      busy: false,
    },
    ...overrides,
  };
}

describe('LibraryScreen', () => {
  it('renders the import-focused empty library without book containers', () => {
    const markup = renderToStaticMarkup(<LibraryScreen model={model([])} actions={actions()} />);

    expect(markup).toContain('class="library-screen"');
    expect(markup).toContain('읽을 파일을 책장에 추가하세요');
    expect(markup).toContain('RAR/CBR');
    expect(markup).toContain('샘플 추가');
    expect(markup).not.toContain('class="books-grid"');
    expect(markup).not.toContain('class="books-list"');
  });

  it('distinguishes loading and failed bootstrap states from an empty library', () => {
    const screenActions = actions();
    const loadingMarkup = renderToStaticMarkup(
      <LibraryScreen model={model([], { bootstrap: { status: 'loading' } })} actions={screenActions} />,
    );
    const failedElements = collectHostElements(
      LibraryScreen({
        model: model([], { bootstrap: { status: 'failed', message: '저장소 오류' } }),
        actions: screenActions,
      }),
    );
    const retryButton = failedElements.find(
      (element) => element.type === 'button' && element.props.className === 'primary-btn',
    );

    expect(loadingMarkup).toContain('aria-busy="true"');
    expect(loadingMarkup).toContain('책장을 불러오는 중입니다');
    expect(loadingMarkup).not.toContain('TXT 파일을 책장에 추가하세요');
    expect(
      renderToStaticMarkup(
        LibraryScreen({
          model: model([], { bootstrap: { status: 'failed', message: '저장소 오류' } }),
          actions: screenActions,
        }),
      ),
    ).toContain('저장소 오류');
    (retryButton!.props.onClick as () => void)();
    expect(screenActions.header.retryBootstrap).toHaveBeenCalledOnce();
  });

  it('renders recent, reading, and unread books from the collection model', () => {
    const reading = novel({
      id: 'reading',
      title: '읽는 작품',
      lastReadAt: '2026-07-09T12:00:00.000Z',
      lastReadProgress: 0.45,
      readingSeconds: 125,
      favorite: true,
    });
    const unread = novel({
      id: 'unread',
      title: '미독 작품',
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
      coverSeed: 2,
    });
    const screenModel = model([unread, reading]);
    const markup = renderToStaticMarkup(<LibraryScreen model={screenModel} actions={actions()} />);

    expect(screenModel.collection.featuredBook?.novel.id).toBe('reading');
    expect(screenModel.collection.filterCounts).toEqual({
      all: 2,
      reading: 1,
      finished: 0,
      unread: 1,
      favorite: 1,
      trash: 0,
    });
    expect(markup).toContain('이어 읽기');
    expect(markup).toContain('읽는 작품');
    expect(markup).toContain('미독 작품');
    expect(markup).toContain('읽는 중');
    expect(markup).toContain('미독');
    expect(markup.match(/<article class="book-card/g)).toHaveLength(2);
  });

  it.each(['grid', 'list'] as const)('focuses %s items without navigating and keeps explicit actions', (viewMode) => {
    const reading = novel({
      id: 'reading',
      title: '읽는 작품',
      lastReadAt: '2026-07-09T12:00:00.000Z',
      lastReadProgress: 0.45,
      favorite: true,
    });
    const screenActions = actions();
    const screenModel = model([reading], { viewMode });
    const hostElements = collectHostElements(LibraryScreen({ model: screenModel, actions: screenActions }));
    const article = hostElements.find((element) => element.type === 'article');
    const openButton = hostElements.find(
      (element) => element.type === 'button' && element.props.className === 'book-card-open',
    );
    const favoriteButton = hostElements.find(
      (element) => element.type === 'button' && element.props['aria-label'] === '읽는 작품 즐겨찾기 해제',
    );
    const chaptersButton = hostElements.find(
      (element) => element.type === 'button' && element.props['aria-label'] === '읽는 작품 화 목록 열기',
    );

    expect(article?.props.onClick).toBeUndefined();
    expect(openButton?.props.type).toBe('button');
    expect(openButton?.props['aria-label']).toBe('읽는 작품 작품 정보 보기');
    expect(openButton?.props.children).toBeUndefined();
    expect(favoriteButton?.props['aria-pressed']).toBe(true);

    (openButton!.props.onClick as () => void)();
    (chaptersButton!.props.onClick as () => void)();
    (favoriteButton!.props.onClick as () => void)();

    expect(screenActions.presentation.focusBook).toHaveBeenCalledOnce();
    expect(screenActions.presentation.focusBook).toHaveBeenCalledWith(reading);
    expect(screenActions.books.open).toHaveBeenCalledOnce();
    expect(screenActions.books.open).toHaveBeenCalledWith(reading);
    expect(screenActions.books.toggleFavorite).toHaveBeenCalledOnce();
    expect(screenActions.books.toggleFavorite).toHaveBeenCalledWith(reading);
  });

  it('announces library selection state and exposes it on each selectable book', () => {
    const selected = novel({ id: 'selected', title: '선택한 작품' });
    const markup = renderToStaticMarkup(
      <LibraryScreen
        model={model([selected], {
          management: {
            available: true,
            shelves: [],
            selectionMode: true,
            selectedBookIds: new Set([selected.id]),
            busy: false,
          },
        })}
        actions={actions()}
      />,
    );

    expect(markup).toContain('role="status" aria-live="polite"');
    expect(markup).toContain('1권 선택됨');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="선택한 작품 선택 해제"');
  });

  it('exposes names and current states for search, filters, view controls, and progress', () => {
    const reading = novel({
      title: '접근성 작품',
      lastReadAt: '2026-07-09T12:00:00.000Z',
      lastReadProgress: 0.45,
    });
    const markup = renderToStaticMarkup(<LibraryScreen model={model([reading])} actions={actions()} />);

    expect(markup).toContain('type="search"');
    expect(markup).toContain('aria-label="책장 검색"');
    expect(markup).toContain('aria-label="책장 필터"');
    expect(markup).toContain('aria-label="책장 정렬"');
    expect(markup).toContain('role="group" aria-label="책장 보기 방식"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('role="progressbar" aria-label="접근성 작품 읽기 진행률"');
    expect(markup).toContain('aria-valuenow="45"');
    expect(markup).toContain('aria-label="책 가져오기"');
    expect(markup).toContain('aria-label="책장 메뉴 열기"');
  });

  it('shows the stored original file and a direct download action in the book inspector', () => {
    const stored = novel({
      title: '클라우드 작품',
      sourceAssetId: 'source-1',
      sourceFileName: 'cloud-book.epub',
      sourceByteLength: 2 * 1024 * 1024,
      sourceContentType: 'application/epub+zip',
    });
    const markup = renderToStaticMarkup(<LibraryScreen model={model([stored])} actions={actions()} />);

    expect(markup).toContain('aria-label="클라우드 작품 원본 파일 다운로드"');
    expect(markup).toContain('원본 다운로드');
    expect(markup).toContain('cloud-book.epub');
    expect(markup).toContain('2 MB');
  });

  it('provides a compact filter selector for narrow layouts', () => {
    const screenActions = actions();
    const hostElements = collectHostElements(LibraryScreen({ model: model([novel()]), actions: screenActions }));
    const mobileFilter = hostElements.find(
      (element) => element.type === 'select' && element.props['aria-label'] === '책장 필터',
    );

    expect(mobileFilter).toBeDefined();
    (mobileFilter!.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'favorite' },
    });
    expect(screenActions.controls.setFilter).toHaveBeenCalledWith('favorite');
  });

  it('opens the chapter list when a mobile book item is activated', () => {
    const reading = novel({ id: 'reading', title: '모바일 작품', lastReadProgress: 0.3 });
    const screenActions = actions();
    const screenModel = model([reading], {
      viewMode: 'list',
      presentation: {
        layoutMode: 'mobile',
        focusedBookId: reading.id,
        inspectorOpen: false,
        shelfBookCounts: new Map(),
      },
    });
    const hostElements = collectHostElements(LibraryScreen({ model: screenModel, actions: screenActions }));
    const openButton = hostElements.find(
      (element) => element.type === 'button' && element.props['aria-label'] === '모바일 작품 화 목록 열기',
    );

    (openButton!.props.onClick as () => void)();

    expect(screenActions.books.open).toHaveBeenCalledWith(reading);
    expect(screenActions.presentation.focusBook).not.toHaveBeenCalled();
  });
});
