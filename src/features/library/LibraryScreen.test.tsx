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
    if (
      Component.name === 'LibraryMobileHeader' ||
      Component.name === 'LibraryInspector' ||
      Component.name === 'ActiveLibraryBatchBar'
    )
      return [];
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
      goHome: vi.fn(),
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
  it('uses one atomic home action from the desktop brand', () => {
    const screenActions = actions();
    const elements = collectHostElements(LibraryScreen({ model: model([novel()]), actions: screenActions }));
    const home = elements.find(
      (element) => element.type === 'button' && element.props['aria-label'] === '라이브러리 메인',
    );

    (home!.props.onClick as () => void)();

    expect(screenActions.presentation.goHome).toHaveBeenCalledOnce();
  });

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
      totalChapters: 10,
      lastReadChapterIndex: 4,
      lastReadProgress: 0.337,
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
    expect(markup).toContain('4 / 10화');
    expect(markup).toContain('34%');
    expect(markup).not.toContain('37%');
    expect(markup).toContain('미독 작품');
    expect(markup).toContain('읽는 중');
    expect(markup).toContain('미독');
    expect(markup.match(/<article class="book-card/g)).toHaveLength(2);
  });

  it.each(['grid', 'list'] as const)(
    'opens %s item details and keeps the direct reading action separate',
    (viewMode) => {
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
      const continueButton = hostElements.find(
        (element) => element.type === 'button' && element.props['aria-label'] === '읽는 작품 이어 읽기',
      );

      expect(article?.props.onClick).toBeUndefined();
      expect(openButton?.props.type).toBe('button');
      expect(openButton?.props['aria-label']).toBe('읽는 작품 작품 상세 열기');
      expect(openButton?.props.children).toBeUndefined();
      expect(favoriteButton?.props['aria-pressed']).toBe(true);

      (openButton!.props.onClick as () => void)();
      (continueButton!.props.onClick as () => void)();
      (favoriteButton!.props.onClick as () => void)();

      expect(screenActions.presentation.focusBook).toHaveBeenCalledOnce();
      expect(screenActions.presentation.focusBook).toHaveBeenCalledWith(reading);
      expect(screenActions.books.open).toHaveBeenCalledOnce();
      expect(screenActions.books.open).toHaveBeenCalledWith(reading);
      expect(screenActions.books.continueReading).toHaveBeenCalledOnce();
      expect(screenActions.books.continueReading).toHaveBeenCalledWith(reading);
      expect(screenActions.books.toggleFavorite).toHaveBeenCalledOnce();
      expect(screenActions.books.toggleFavorite).toHaveBeenCalledWith(reading);
    },
  );

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

  it('keeps collection add and remove actions available in the selection batch sheet', () => {
    const selected = novel({ id: 'selected', title: '책장 이동 작품' });
    const markup = renderToStaticMarkup(
      <LibraryScreen
        model={model([selected], {
          management: {
            available: true,
            shelves: [
              {
                id: 'shelf-1',
                name: '보관할 책장',
                color: '#596f92',
                sortOrder: 0,
                createdAt: '2026-07-01T00:00:00.000Z',
                updatedAt: '2026-07-01T00:00:00.000Z',
                revision: 1,
              },
            ],
            activeShelfId: 'shelf-1',
            selectionMode: true,
            selectedBookIds: new Set([selected.id]),
            busy: false,
          },
        })}
        actions={actions()}
      />,
    );

    expect(markup).toContain('책장 · 컬렉션');
    expect(markup).toContain('선택 책장에 추가');
    expect(markup).toContain('선택 책장에서 제외');
    expect(markup).toContain('aria-label="선택 종료"');
  });

  it('toggles a selection without opening or focusing the book', () => {
    const selected = novel({ id: 'selected', title: '선택 테스트' });
    const screenActions = actions();
    const screenModel = model([selected], {
      management: {
        available: true,
        shelves: [],
        selectionMode: true,
        selectedBookIds: new Set(),
        busy: false,
      },
    });
    const elements = collectHostElements(LibraryScreen({ model: screenModel, actions: screenActions }));
    const itemButton = elements.find(
      (element) => element.type === 'button' && element.props['aria-label'] === '선택 테스트 선택',
    );

    (itemButton!.props.onClick as () => void)();

    expect(screenActions.books.toggleSelected).toHaveBeenCalledWith(selected);
    expect(screenActions.books.open).not.toHaveBeenCalled();
    expect(screenActions.presentation.focusBook).not.toHaveBeenCalled();
  });

  it('keeps trashed books in management flow instead of opening them', () => {
    const trashed = novel({ id: 'trash', title: '휴지통 작품', deletedAt: '2026-07-10T00:00:00.000Z' });
    const screenActions = actions();
    const screenModel = model([trashed], {
      filter: 'trash',
      collection: buildLibraryCollectionModel({
        novels: [trashed],
        query: '',
        filter: 'trash',
        sort: 'recent',
        readState,
      }),
    });
    const elements = collectHostElements(LibraryScreen({ model: screenModel, actions: screenActions }));
    const itemButton = elements.find(
      (element) => element.type === 'button' && element.props['aria-label'] === '휴지통 작품 작품 상세 열기',
    );

    (itemButton!.props.onClick as () => void)();

    expect(screenActions.presentation.focusBook).toHaveBeenCalledWith(trashed);
    expect(screenActions.books.open).not.toHaveBeenCalled();
  });

  it('exposes names and current states for search, filters, view controls, and progress', () => {
    const reading = novel({
      title: '접근성 작품',
      lastReadAt: '2026-07-09T12:00:00.000Z',
      totalChapters: 10,
      lastReadChapterIndex: 4,
      lastReadProgress: 0.337,
    });
    const markup = renderToStaticMarkup(<LibraryScreen model={model([reading])} actions={actions()} />);

    expect(markup).toContain('type="search"');
    expect(markup).toContain('aria-label="책장 검색"');
    expect(markup).toContain('aria-label="책장 필터"');
    expect(markup).toContain('aria-label="책장 정렬"');
    expect(markup).toContain('role="group" aria-label="책장 보기 방식"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('role="progressbar" aria-label="접근성 작품 전체 작품 진행률"');
    expect(markup).toContain('aria-valuenow="34"');
    expect(markup).toContain('aria-valuetext="4 / 10화 · 전체 34%"');
    expect(markup).toContain('aria-label="책 가져오기"');
    expect(markup).toContain('aria-label="라이브러리 메뉴"');
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
      (element) => element.type === 'button' && element.props['aria-label'] === '모바일 작품 작품 상세 열기',
    );

    (openButton!.props.onClick as () => void)();

    expect(screenActions.books.open).toHaveBeenCalledWith(reading);
    expect(screenActions.presentation.focusBook).toHaveBeenCalledWith(reading);
  });

  it('derives direct action labels and exposes only whole-book progress in library projections', () => {
    const reading = novel({ totalChapters: 10, lastReadChapterIndex: 4, lastReadProgress: 0.337 });
    const unread = novel({ id: 'unread', title: '안 읽은 작품' });
    const fixed = novel({
      id: 'fixed',
      title: '스캔 문서',
      format: 'pdf',
      sourceFileName: 'scan.pdf',
      lastReadProgress: 0.4,
      lastReadAt: '2026-07-09T12:00:00.000Z',
    });

    const readingView = buildLibraryCollectionModel({
      novels: [reading],
      query: '',
      filter: 'all',
      sort: 'recent',
      readState,
    }).visibleBooks[0]!;
    const unreadView = buildLibraryCollectionModel({
      novels: [unread],
      query: '',
      filter: 'all',
      sort: 'recent',
      readState,
    }).visibleBooks[0]!;
    const fixedView = buildLibraryCollectionModel({
      novels: [fixed],
      query: '',
      filter: 'all',
      sort: 'recent',
      readState,
    }).visibleBooks[0]!;

    expect(readingView.bookProgress).toBeCloseTo(0.337);
    expect(readingView).not.toHaveProperty('chapterProgress');
    expect(readingView.directActionLabel).toBe('이어 읽기');
    expect(unreadView.directActionLabel).toBe('첫 화 보기');
    expect(fixedView.directActionLabel).toBe('이어 보기');
  });

  it('routes fixed documents through the existing open and continue actions', () => {
    const fixed = novel({
      id: 'fixed',
      title: '고정 문서',
      format: 'pdf',
      sourceFileName: 'fixed.pdf',
      lastReadProgress: 0.4,
      lastReadAt: '2026-07-09T12:00:00.000Z',
    });
    const screenActions = actions();
    const elements = collectHostElements(LibraryScreen({ model: model([fixed]), actions: screenActions }));
    const body = elements.find(
      (element) => element.type === 'button' && element.props['aria-label'] === '고정 문서 문서 열기',
    );
    const direct = elements.find(
      (element) => element.type === 'button' && element.props['aria-label'] === '고정 문서 이어 보기',
    );

    (body!.props.onClick as () => void)();
    (direct!.props.onClick as () => void)();

    expect(screenActions.books.open).toHaveBeenCalledWith(fixed);
    expect(screenActions.books.continueReading).toHaveBeenCalledWith(fixed);
  });
});
