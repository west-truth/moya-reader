import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LibraryScreenProps } from '../library/library-screen-contract';
import SourceHubScreen from './SourceHubScreen';
import type { ExternalSourceController } from './useExternalSourceController';
import { testNovel } from '../book-workspace/book-workspace-test-fixtures';

function controller(overrides: Partial<ExternalSourceController> = {}): ExternalSourceController {
  return {
    open: true,
    loading: false,
    busy: false,
    blockingBusy: false,
    importBusy: false,
    selectedBatchActive: false,
    tasks: [],
    sources: [
      {
        id: 'fixture.source',
        title: '개발용 작품 소스',
        kind: 'catalog',
        origin: 'plugin',
        connection: { state: 'connected', label: '개발 연결' },
      },
    ],
    activeSourceId: 'fixture.source',
    items: [
      {
        key: { connectorId: 'fixture.source', remoteId: 'work-1' },
        kind: 'work',
        title: '외부 작품',
        importFileName: '외부 작품.txt',
        author: '테스트 작가',
        formatHint: 'TXT',
        byteLength: 1024,
        updatedAt: '2026-08-23T00:00:00.000Z',
        importability: 'supported',
        selected: false,
        importState: 'available',
      },
    ],
    query: '',
    stale: false,
    detail: undefined,
    localSeriesSourceId: undefined,
    browse: undefined,
    filterValues: {},
    breadcrumbs: [{ label: '전체' }],
    currentFolderIsDefault: false,
    currentLocationCanBeDefault: false,
    canPickItems: false,
    canRemoveItems: false,
    subscriptions: [],
    libraryWorks: [],
    activeSubscription: undefined,
    checkingSubscriptions: false,
    canSubscribeCurrentWork: false,
    canQueueItem: vi.fn(() => false),
    isWorkInLibrary: vi.fn(() => false),
    addWorkToLibrary: vi.fn(async () => undefined),
    addCurrentWorkToLibrary: vi.fn(async () => undefined),
    removeLibraryWork: vi.fn(async () => undefined),
    show: vi.fn(),
    showLocalSeries: vi.fn(async () => undefined),
    close: vi.fn(),
    selectSource: vi.fn(async () => undefined),
    setQuery: vi.fn(),
    search: vi.fn(async () => undefined),
    setBrowseMode: vi.fn(async () => undefined),
    setFilterValue: vi.fn(),
    applyFilters: vi.fn(async () => undefined),
    resetFilters: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    loadMore: vi.fn(async () => undefined),
    toggleItem: vi.fn(),
    selectAllSupported: vi.fn(),
    importItem: vi.fn(async () => undefined),
    importAndOpen: vi.fn(async () => undefined),
    importSelected: vi.fn(async () => undefined),
    openImported: vi.fn(async () => undefined),
    dismissTask: vi.fn(),
    cancel: vi.fn(),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    openItem: vi.fn(async () => undefined),
    openFolder: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    setCurrentFolderAsDefault: vi.fn(async () => undefined),
    clearDefaultFolder: vi.fn(async () => undefined),
    pickItems: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
    subscribeCurrentWork: vi.fn(async () => undefined),
    unsubscribeCurrentWork: vi.fn(async () => undefined),
    acknowledgeNewReleases: vi.fn(async () => undefined),
    selectNewReleases: vi.fn(),
    checkSubscriptions: vi.fn(async () => undefined),
    openSubscription: vi.fn(async () => undefined),
    ...overrides,
  };
}

const library = {
  model: {
    query: '',
    filter: 'all',
    sort: 'recent',
    viewMode: 'grid',
    sync: { label: '연결 안 됨', tone: 'local' },
    externalSources: {
      active: true,
      activeSourceId: 'fixture.source',
      busy: false,
      sources: [{ id: 'fixture.source', title: '개발용 작품 소스', kind: 'catalog' }],
    },
    collection: {
      filterCounts: { all: 0, reading: 0, finished: 0, unread: 0, favorite: 0, trash: 0 },
    },
    presentation: { shelfBookCounts: new Map() },
    management: { available: false, shelves: [], selectionMode: false, selectedBookIds: new Set(), busy: false },
  },
  actions: {
    presentation: { goHome: vi.fn() },
    controls: { setFilter: vi.fn(), setShelf: vi.fn() },
    books: { continueReading: vi.fn(), toggleFavorite: vi.fn(), editMetadata: vi.fn() },
    header: {
      setQuery: vi.fn(),
      openImport: vi.fn(),
      openLibraryFolders: vi.fn(),
      openSync: vi.fn(),
      openBackup: vi.fn(),
      openSettings: vi.fn(),
      openExternalSource: vi.fn(),
      openExternalSourceSettings: vi.fn(),
    },
  },
} as unknown as LibraryScreenProps;

describe('SourceHubScreen', () => {
  it('labels an empty-query extension search as filter results', () => {
    const markup = renderToStaticMarkup(
      <SourceHubScreen
        controller={controller({
          query: '',
          browse: { activeMode: 'search', availableModes: ['popular', 'search'], filters: [] },
        })}
        library={library}
        openSourceSettings={vi.fn()}
      />,
    );

    expect(markup).toContain('필터 결과');
    expect(markup).not.toContain('검색 결과');
  });

  it('renders a connected catalog as a first-class library-style card screen', () => {
    const markup = renderToStaticMarkup(
      <SourceHubScreen controller={controller({ stale: true })} library={library} openSourceSettings={vi.fn()} />,
    );

    expect(markup).toContain('source-hub-screen');
    expect(markup).toContain('개발용 작품 소스');
    expect(markup).toContain('외부 작품');
    expect(markup).toContain('테스트 작가');
    expect(markup).toContain('저장된 목록');
    expect(markup).toContain('라이브러리로 추가');
    const coverMarkup = markup.match(/<div class="source-hub-card-cover"[^>]*>(.*?)<\/div>/s)?.[1] ?? '';
    expect(coverMarkup).not.toContain('외부 작품');
    expect(coverMarkup).not.toContain('TXT');
    expect(markup).not.toContain('role="dialog"');
  });

  it('shows explicit update and imported-book actions without automatic download wording', () => {
    const update = controller({
      items: [
        {
          key: { connectorId: 'fixture.source', remoteId: 'work-1' },
          kind: 'work',
          title: '업데이트 작품',
          importability: 'supported',
          selected: false,
          importState: 'update_available',
          localBookId: 'local-1',
          localBookTitle: '기존 작품',
        },
        {
          key: { connectorId: 'fixture.source', remoteId: 'work-2' },
          kind: 'work',
          title: '가져온 작품',
          importability: 'supported',
          selected: false,
          importState: 'imported',
          localBookId: 'local-2',
          localBookTitle: '가져온 작품',
        },
      ],
    });
    const markup = renderToStaticMarkup(
      <SourceHubScreen controller={update} library={library} openSourceSettings={vi.fn()} />,
    );

    expect(markup).toContain('업데이트 있음');
    expect(markup).toContain('직접 업데이트하기 전까지 책장의 현재 본문은 유지됩니다.');
    expect(markup).toContain('라이브러리에서 보기');
    expect(markup).toContain('업데이트</button>');
  });

  it('renders Suwayomi work navigation and explains that selected chapters accumulate in one local series', () => {
    const browseMarkup = renderToStaticMarkup(
      <SourceHubScreen
        controller={controller({
          sources: [
            {
              id: 'moya.external.suwayomi',
              title: 'Suwayomi',
              kind: 'catalog',
              origin: 'built_in',
              connection: { state: 'connected', label: 'Local Suwayomi' },
              supportsSubscriptions: true,
              newReleaseCount: 2,
            },
          ],
          activeSourceId: 'moya.external.suwayomi',
          subscriptions: [
            {
              id: 'subscription-1',
              connectorId: 'moya.external.suwayomi',
              collectionRemoteId: 'manga:1',
              navigationRef: 'manga:1',
              title: '라이브러리 작품',
              sourceLabel: '테스트 소스',
              knownReleaseIds: ['chapter:1', 'chapter:2'],
              newReleaseIds: ['chapter:2'],
              availableReleaseCount: 2,
              lastCheckedAt: '2026-08-26T00:00:00.000Z',
              createdAt: '2026-08-25T00:00:00.000Z',
              updatedAt: '2026-08-26T00:00:00.000Z',
              schemaVersion: 1,
            },
          ],
          items: [
            {
              key: { connectorId: 'moya.external.suwayomi', remoteId: 'manga:1' },
              kind: 'work',
              title: '연동 작품',
              navigationRef: 'manga:1',
              importability: 'unsupported',
              selected: false,
              importState: 'unsupported',
            },
          ],
        })}
        library={library}
        openSourceSettings={vi.fn()}
        openLocalSeriesImport={vi.fn()}
      />,
    );
    const detailMarkup = renderToStaticMarkup(
      <SourceHubScreen
        controller={controller({
          sources: [
            {
              id: 'moya.external.suwayomi',
              title: 'Suwayomi',
              kind: 'catalog',
              origin: 'built_in',
              connection: { state: 'connected', label: 'Local Suwayomi' },
              supportsSubscriptions: true,
              newReleaseCount: 1,
            },
          ],
          activeSourceId: 'moya.external.suwayomi',
          detail: {
            title: '연동 작품',
            author: '작가',
            description: '작품 설명',
            tags: ['판타지'],
            thumbnailUrl: 'http://localhost:4567/api/v1/manga/1/thumbnail',
          },
          breadcrumbs: [{ label: '전체' }, { label: '연동 작품', parentRef: 'manga:1' }],
          canSubscribeCurrentWork: true,
          activeSubscription: {
            id: 'subscription-1',
            connectorId: 'moya.external.suwayomi',
            collectionRemoteId: 'manga:1',
            navigationRef: 'manga:1',
            title: '연동 작품',
            knownReleaseIds: ['chapter:11'],
            newReleaseIds: ['chapter:11'],
            availableReleaseCount: 1,
            lastCheckedAt: '2026-08-26T00:00:00.000Z',
            createdAt: '2026-08-25T00:00:00.000Z',
            updatedAt: '2026-08-26T00:00:00.000Z',
            schemaVersion: 1,
          },
          items: [
            {
              key: { connectorId: 'moya.external.suwayomi', remoteId: 'chapter:11' },
              kind: 'file',
              title: '1화',
              formatHint: 'CBZ',
              collection: { remoteId: 'manga:1', title: '연동 작품' },
              release: { title: '1화', chapterNumber: 1 },
              importability: 'supported',
              selected: false,
              importState: 'available',
            },
          ],
        })}
        library={library}
        openSourceSettings={vi.fn()}
        openLocalSeriesImport={vi.fn()}
      />,
    );

    expect(browseMarkup).not.toContain('탐색 가능');
    expect(browseMarkup).not.toContain('작품·회차 보기');
    expect(browseMarkup).toContain('작품 상세 열기');
    expect(browseMarkup).toContain('라이브러리 추가');
    expect(browseMarkup).not.toContain('연동 작품 선택');
    expect(browseMarkup).toContain('라이브러리에 추가한 작품');
    expect(browseMarkup).toContain('새 회차 1');
    expect(browseMarkup).toContain('새 회차 확인');
    expect(detailMarkup).toContain('작품 설명');
    expect(detailMarkup).toContain('회차</h2>');
    expect(detailMarkup).not.toContain('선택한 회차는 하나의 연재 작품에 누적됩니다');
    expect(detailMarkup).toContain('book-detail-hero');
    expect(detailMarkup).toContain('detail-stats');
    expect(detailMarkup).toContain('source-hub-release-list');
    expect(detailMarkup).toContain('source-hub-release-list-head');
    expect(detailMarkup).toContain('다운로드 후 보기');
    expect(detailMarkup).toContain('source-hub-release-action');
    expect(detailMarkup).not.toContain('source-hub-card-cover');
    expect(detailMarkup).toContain('source-hub-remote-cover');
    expect(detailMarkup).toContain('thumbnail');
    expect(detailMarkup).toContain('연재 상태');
    expect(detailMarkup).not.toContain('WEBTOON');
    expect(detailMarkup).not.toContain('기본 폴더로 설정');
    expect(detailMarkup).toContain('라이브러리에서 제거');
    expect(detailMarkup).toContain('새 회차 선택');
  });

  it('offers a persistent default-folder action only inside a nested folder', () => {
    const nested = controller({
      breadcrumbs: [{ label: '최상위 폴더' }, { label: '소설', parentRef: '/소설' }],
      currentLocationCanBeDefault: true,
    });
    const markup = renderToStaticMarkup(
      <SourceHubScreen controller={nested} library={library} openSourceSettings={vi.fn()} />,
    );
    const selectedMarkup = renderToStaticMarkup(
      <SourceHubScreen
        controller={controller({ ...nested, currentFolderIsDefault: true })}
        library={library}
        openSourceSettings={vi.fn()}
      />,
    );

    expect(markup).toContain('현재 폴더를 기본 폴더로 설정');
    expect(markup).toContain('기본 폴더로 설정');
    expect(selectedMarkup).toContain('기본 폴더 해제');
  });

  it('renders Google-style selected-file add and remove actions without exposing full-drive browsing', () => {
    const google = controller({
      canPickItems: true,
      canRemoveItems: true,
      items: [],
      sources: [
        {
          id: 'moya.external.google-drive.files',
          title: 'Google Drive',
          kind: 'cloud_file',
          origin: 'built_in',
          connection: { state: 'connected', label: 'reader@example.com' },
        },
      ],
      activeSourceId: 'moya.external.google-drive.files',
    });
    const emptyMarkup = renderToStaticMarkup(
      <SourceHubScreen controller={google} library={library} openSourceSettings={vi.fn()} />,
    );
    const selectedMarkup = renderToStaticMarkup(
      <SourceHubScreen
        controller={controller({
          ...google,
          items: [
            {
              key: {
                connectorId: 'moya.external.google-drive.files',
                accountConnectionId: 'google-drive:p1',
                remoteId: 'file-1',
              },
              kind: 'file',
              title: '선택한 작품.epub',
              importability: 'supported',
              selected: false,
              importState: 'available',
            },
          ],
        })}
        library={library}
        openSourceSettings={vi.fn()}
      />,
    );

    expect(emptyMarkup).toContain('Drive에서 파일 추가');
    expect(emptyMarkup).toContain('연결할 파일을 선택해 보세요');
    expect(emptyMarkup).not.toContain('전체 Drive 탐색');
    expect(selectedMarkup).toContain('선택한 작품.epub 선택 목록에서 제거');
  });

  it('makes the active release spinner the download cancel button', () => {
    const markup = renderToStaticMarkup(
      <SourceHubScreen
        controller={controller({
          busy: true,
          importBusy: true,
          detail: { title: '연동 작품' },
          items: [
            {
              key: { connectorId: 'fixture.source', remoteId: 'work-1' },
              kind: 'file',
              title: '1화',
              collection: { remoteId: 'manga:1', title: '연동 작품' },
              release: { title: '1화', chapterNumber: 1 },
              importability: 'supported',
              selected: true,
              importState: 'available',
            },
          ],
          tasks: [
            {
              id: 'task-1',
              batchId: 'batch-1',
              source: 'external_source',
              title: '연동 작품',
              externalItemKey: 'fixture.source::::work-1',
              phase: 'downloading',
            },
          ],
          progress: {
            current: 1,
            total: 1,
            completed: 0,
            failed: 0,
            linkedExisting: 0,
            fileName: '큰 작품.epub',
            phase: 'downloading',
          },
        })}
        library={library}
        openSourceSettings={vi.fn()}
      />,
    );

    expect(markup).toContain('다운로드 중');
    expect(markup).toContain('spin');
    expect(markup).toContain('aria-label="1화 다운로드 중단"');
    expect(markup).not.toContain('source-hub-batch-bar');
    expect(markup).not.toContain('외부 작품 가져오기 진행률');
    expect(markup).toContain('라이브러리</button>');
  });

  it('shows a cancellable bottom status bar only for a selected batch', () => {
    const markup = renderToStaticMarkup(
      <SourceHubScreen
        controller={controller({
          busy: true,
          importBusy: true,
          selectedBatchActive: true,
          detail: { title: '연동 작품' },
          items: [],
          progress: {
            current: 2,
            total: 4,
            completed: 1,
            failed: 0,
            linkedExisting: 0,
            phase: 'downloading',
          },
        })}
        library={library}
        openSourceSettings={vi.fn()}
      />,
    );

    expect(markup).toContain('source-hub-batch-bar is-progress');
    expect(markup).toContain('선택 회차 다운로드 중');
    expect(markup).toContain('1/4 완료');
    expect(markup).toContain('중단');
  });

  it('disables release downloads for another work while keeping the active work queue available', () => {
    const release = {
      key: { connectorId: 'fixture.source', remoteId: 'work-2' },
      kind: 'file' as const,
      title: '2화',
      collection: { remoteId: 'manga:2', title: '다른 작품' },
      release: { title: '2화', chapterNumber: 2 },
      importability: 'supported' as const,
      selected: false,
      importState: 'available' as const,
    };
    const blockedMarkup = renderToStaticMarkup(
      <SourceHubScreen
        controller={controller({
          busy: true,
          importBusy: true,
          detail: { title: '다른 작품' },
          items: [release],
          canQueueItem: vi.fn(() => false),
        })}
        library={library}
        openSourceSettings={vi.fn()}
      />,
    );
    const queuedMarkup = renderToStaticMarkup(
      <SourceHubScreen
        controller={controller({
          busy: true,
          importBusy: true,
          detail: { title: '연동 작품' },
          items: [{ ...release, collection: { remoteId: 'manga:1', title: '연동 작품' } }],
          canQueueItem: vi.fn(() => true),
        })}
        library={library}
        openSourceSettings={vi.fn()}
      />,
    );

    const blockedAction = blockedMarkup.match(/<button[^>]*title="다른 작품 다운로드 중"[^>]*>/u)?.[0];
    expect(blockedAction).toBeDefined();
    expect(blockedAction).toContain('disabled');
    expect(queuedMarkup).toContain('다운로드 대기열에 추가');
    const queuedAction = queuedMarkup.match(/<button[^>]*title="다운로드 대기열에 추가"[^>]*>/u)?.[0];
    expect(queuedAction).toBeDefined();
    expect(queuedAction).not.toContain('disabled');
  });

  it('keeps a compact batch download action before the selected releases start', () => {
    const markup = renderToStaticMarkup(
      <SourceHubScreen
        controller={controller({
          detail: { title: '연동 작품' },
          items: [
            {
              key: { connectorId: 'fixture.source', remoteId: 'work-1' },
              kind: 'file',
              title: '1화',
              collection: { remoteId: 'manga:1', title: '연동 작품' },
              release: { title: '1화', chapterNumber: 1 },
              importability: 'supported',
              selected: true,
              importState: 'available',
            },
          ],
        })}
        library={library}
        openSourceSettings={vi.fn()}
      />,
    );

    expect(markup).toContain('source-hub-batch-bar');
    expect(markup).toContain('1개 선택');
    expect(markup).toContain('선택 회차 다운로드');
  });

  it('keeps existing source results visible with an explicit loading indicator', () => {
    const markup = renderToStaticMarkup(
      <SourceHubScreen controller={controller({ loading: true })} library={library} openSourceSettings={vi.fn()} />,
    );

    expect(markup).toContain('source-hub-loading-status');
    expect(markup).toContain('목록을 불러오는 중');
    expect(markup).toContain('spin');
    expect(markup).toContain('외부 작품');
  });

  it('keeps a completed release openable while a later release is queued', () => {
    const markup = renderToStaticMarkup(
      <SourceHubScreen
        controller={controller({
          busy: true,
          importBusy: true,
          detail: { title: '연동 작품' },
          items: [
            {
              key: { connectorId: 'fixture.source', accountConnectionId: 'fixture-account', remoteId: 'chapter:1' },
              kind: 'file',
              title: '1화',
              collection: { remoteId: 'manga:1', title: '연동 작품' },
              release: { title: '1화', chapterNumber: 1 },
              importability: 'supported',
              selected: false,
              importState: 'imported',
              localBookId: 'book-1',
            },
            {
              key: { connectorId: 'fixture.source', accountConnectionId: 'fixture-account', remoteId: 'chapter:2' },
              kind: 'file',
              title: '2화',
              collection: { remoteId: 'manga:1', title: '연동 작품' },
              release: { title: '2화', chapterNumber: 2 },
              importability: 'supported',
              selected: true,
              importState: 'available',
            },
          ],
          tasks: [
            {
              id: 'task-2',
              batchId: 'batch-1',
              source: 'external_source',
              title: '연동 작품',
              externalItemKey: 'fixture.source::fixture-account::chapter:2',
              phase: 'queued',
              current: 2,
              total: 2,
            },
          ],
        })}
        library={library}
        openSourceSettings={vi.fn()}
      />,
    );

    const completedAction = markup.match(/<button[^>]*aria-label="1화 보기"[^>]*>/u)?.[0];
    expect(completedAction).toBeDefined();
    expect(completedAction).not.toContain('disabled');
    expect(markup).toMatch(/lucide-loader-circle[^>]*spin|spin[^>]*lucide-loader-circle/u);
  });

  it('renders nothing after the active source loses its connection', () => {
    const disconnected = controller({
      sources: [
        {
          id: 'fixture.source',
          title: '연결 해제된 소스',
          kind: 'cloud_file',
          origin: 'built_in',
          connection: { state: 'disconnected' },
        },
      ],
    });

    expect(
      renderToStaticMarkup(
        <SourceHubScreen controller={disconnected} library={library} openSourceSettings={vi.fn()} />,
      ),
    ).toBe('');
  });

  it('keeps downloaded local release rows visible when no remote source is connected', () => {
    const localNovel = testNovel({
      format: 'image_archive',
      title: '로컬 웹툰',
      sourceFileName: '로컬 웹툰.cbz',
      documentSectionCount: 1,
      lastReadProgress: 0.4,
    });
    const titleEditor = {
      editing: false,
      draft: localNovel.title,
      start: vi.fn(),
      cancel: vi.fn(),
      setDraft: vi.fn(),
      save: vi.fn(),
    };
    const localLibrary = {
      ...library,
      model: {
        ...library.model,
        collection: {
          ...library.model.collection,
          booksByNovelId: new Map([
            [localNovel.id, { novel: localNovel, readingStatusLabel: '읽는 중', isUnread: false }],
          ]),
        },
      },
    } as unknown as LibraryScreenProps;
    const markup = renderToStaticMarkup(
      <SourceHubScreen
        controller={controller({
          sources: [],
          activeSourceId: undefined,
          localSeriesNovel: localNovel,
          localSeriesSourceId: undefined,
          detail: { title: localNovel.title },
          items: [
            {
              key: { connectorId: 'moya.local.serial', remoteId: 'local:01' },
              kind: 'file',
              title: '01화',
              collection: { remoteId: `local-series:${localNovel.id}`, title: localNovel.title },
              release: { title: '01화', sourceOrder: 1 },
              importability: 'supported',
              selected: false,
              importState: 'imported',
              localBookId: localNovel.id,
              readingState: 'current',
            },
            {
              key: { connectorId: 'moya.local.serial', remoteId: 'local:02' },
              kind: 'file',
              title: '02화',
              collection: { remoteId: `local-series:${localNovel.id}`, title: localNovel.title },
              release: { title: '02화', sourceOrder: 2 },
              importability: 'supported',
              selected: false,
              importState: 'imported',
              localBookId: localNovel.id,
              readingState: 'unread',
            },
          ],
        })}
        library={localLibrary}
        openSourceSettings={vi.fn()}
        openLocalSeriesImport={vi.fn()}
        localSeriesNovel={localNovel}
        localSeriesTitleEditor={titleEditor}
      />,
    );

    expect(markup).toContain('로컬 웹툰');
    expect(markup).toContain('<span class="detail-status">읽는 중</span>');
    expect(markup).not.toContain('로컬 회차만 표시');
    expect(markup).toContain('01화');
    expect(markup).toContain('02화');
    expect(markup).toContain('읽는 중');
    expect(markup).toContain('안 읽음');
    expect(markup).toContain('aria-current="location"');
    expect(markup).toContain('source-hub-release-row is-current');
    expect(markup).toContain('보기');
    expect(markup).toContain('이어 보기');
    expect(markup).toContain('즐겨찾기');
    expect(markup).toContain('회차 추가');
    expect(markup).toContain('제목 수정');
    expect(markup).toContain('편집');
    expect(markup).toContain('<dd>CBZ</dd>');
    expect(markup).not.toContain('IMAGE_ARCHIVE');
  });
});
