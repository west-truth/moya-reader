import {
  ArrowDownUp,
  BookOpen,
  Check,
  Cloud,
  DatabaseBackup,
  FileText,
  Folder,
  FolderCog,
  FolderPlus,
  Grid2X2,
  Library,
  List,
  Menu,
  MoreVertical,
  Plus,
  PlugZap,
  RotateCcw,
  Search,
  Settings,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { ModalDrawer } from '../../shared/ui/ModalDrawer';
import { formatCount } from '../../utils/format';
import type { LibraryScreenProps } from './library-screen-contract';
import type { LibraryFilter } from './library-screen-model';

const systemViews: Array<{ value: LibraryFilter; label: string; icon: typeof Library }> = [
  { value: 'all', label: '전체', icon: Library },
  { value: 'reading', label: '읽는 중', icon: BookOpen },
  { value: 'finished', label: '완독', icon: Check },
  { value: 'unread', label: '미독', icon: FileText },
  { value: 'favorite', label: '즐겨찾기', icon: Star },
  { value: 'trash', label: '휴지통', icon: Trash2 },
];

function goLibraryHome({ actions }: LibraryScreenProps): void {
  actions.presentation.goHome();
}

function FilterNavigation({ model, actions, close }: LibraryScreenProps & { close?: () => void }) {
  const counts = model.collection.filterCounts;
  return (
    <nav className="library-sidebar-list" aria-label="작품 상태">
      {systemViews.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.value}
            type="button"
            className={!model.externalSources.active && model.filter === item.value ? 'active' : ''}
            disabled={model.externalSources.busy}
            onClick={() => {
              actions.controls.setFilter(item.value);
              close?.();
            }}
            aria-current={!model.externalSources.active && model.filter === item.value ? 'page' : undefined}
          >
            <Icon size={17} strokeWidth={1.7} />
            <span>{item.label}</span>
            <em>{formatCount(counts[item.value])}</em>
          </button>
        );
      })}
    </nav>
  );
}

function ShelfNavigation({ model, actions, close }: LibraryScreenProps & { close?: () => void }) {
  if (!model.management.available) return null;
  return (
    <nav className="library-sidebar-list" aria-label="사용자 책장">
      <button
        type="button"
        className={!model.externalSources.active && !model.management.activeShelfId ? 'active' : ''}
        disabled={model.externalSources.busy}
        onClick={() => {
          actions.controls.setShelf(undefined);
          close?.();
        }}
        aria-current={!model.externalSources.active && !model.management.activeShelfId ? 'page' : undefined}
      >
        <Folder size={17} strokeWidth={1.7} />
        <span>모든 작품</span>
        <em>{formatCount(model.collection.filterCounts.all)}</em>
      </button>
      {model.management.shelves.map((shelf) => (
        <button
          key={shelf.id}
          type="button"
          className={!model.externalSources.active && model.management.activeShelfId === shelf.id ? 'active' : ''}
          disabled={model.externalSources.busy}
          onClick={() => {
            actions.controls.setShelf(shelf.id);
            close?.();
          }}
          aria-current={
            !model.externalSources.active && model.management.activeShelfId === shelf.id ? 'page' : undefined
          }
        >
          <Folder size={17} strokeWidth={1.7} />
          <span>{shelf.name}</span>
          <em>{formatCount(model.presentation.shelfBookCounts.get(shelf.id) ?? 0)}</em>
        </button>
      ))}
    </nav>
  );
}

function SourceNavigation({ model, actions, close }: LibraryScreenProps & { close?: () => void }) {
  if (model.externalSources.sources.length === 0) return null;
  return (
    <nav className="library-sidebar-list" aria-label="연결된 외부 소스">
      {model.externalSources.sources.map((source) => {
        const Icon = source.kind === 'cloud_file' ? Cloud : PlugZap;
        const active = model.externalSources.active && model.externalSources.activeSourceId === source.id;
        return (
          <button
            key={source.id}
            type="button"
            className={active ? 'active' : ''}
            disabled={model.externalSources.busy}
            aria-label={`${source.title} 소스 열기`}
            aria-current={active ? 'page' : undefined}
            onClick={() => {
              actions.header.openExternalSource(source.id);
              close?.();
            }}
          >
            <Icon size={17} strokeWidth={1.7} />
            <span>{source.title}</span>
            {Boolean(source.newReleaseCount) && (
              <em aria-label={`새 회차 ${source.newReleaseCount}개`}>{source.newReleaseCount}</em>
            )}
          </button>
        );
      })}
    </nav>
  );
}

export function LibrarySidebar(props: LibraryScreenProps) {
  const { model, actions } = props;
  return (
    <aside className="library-sidebar" aria-label="라이브러리 탐색">
      <button
        className="library-brand-lockup"
        type="button"
        onClick={() => goLibraryHome(props)}
        disabled={model.externalSources.busy}
        aria-label="라이브러리 메인"
      >
        <img src="/branding/moya-wordmark.png" alt="MOYA" />
      </button>
      <div className="library-sidebar-scroll">
        <section>
          <span className="library-sidebar-label">라이브러리</span>
          <FilterNavigation {...props} />
        </section>
        {model.management.available && (
          <section className="library-shelf-section">
            <div className="library-sidebar-section-head">
              <span className="library-sidebar-label">책장</span>
              <button type="button" title="책장 관리" aria-label="책장 관리" onClick={actions.controls.openShelves}>
                <FolderCog size={16} />
              </button>
            </div>
            <ShelfNavigation {...props} />
          </section>
        )}
        {model.externalSources.sources.length > 0 && (
          <section className="library-source-section">
            <div className="library-sidebar-section-head">
              <span className="library-sidebar-label">소스</span>
              <button
                type="button"
                title="소스 관리"
                aria-label="소스 관리"
                disabled={model.externalSources.busy}
                onClick={actions.header.openExternalSourceSettings}
              >
                <Settings size={16} />
              </button>
            </div>
            <SourceNavigation {...props} />
          </section>
        )}
      </div>
      <footer className="library-sidebar-footer">
        <button type="button" disabled={model.externalSources.busy} onClick={actions.header.openSettings}>
          <Settings size={18} /> <span>설정</span>
        </button>
        <p>파일과 독서 기록은 이 기기에 저장됩니다.</p>
      </footer>
    </aside>
  );
}

export function LibraryHeader({ model, actions }: LibraryScreenProps) {
  return (
    <header className="library-topbar">
      <label className="search-box library-search">
        <Search size={17} />
        <input
          type="search"
          value={model.query}
          onChange={(event) => actions.header.setQuery(event.target.value)}
          placeholder="책장 검색"
          aria-label="책장 검색"
        />
        <kbd>Ctrl K</kbd>
      </label>
      <div className="library-topbar-actions">
        <button
          className={`library-sync-entry ${model.sync.tone}`}
          type="button"
          onClick={actions.header.openSync}
          aria-label={`동기화 열기: ${model.sync.label}`}
        >
          <span className="library-sync-entry-icon" aria-hidden="true">
            <Cloud size={17} />
          </span>
          <span className="library-sync-entry-copy">
            <strong>동기화</strong>
            <small>{model.sync.label}</small>
          </span>
        </button>
        <button className="ghost-btn" type="button" onClick={actions.header.openBackup} aria-label="백업 및 복원 열기">
          <DatabaseBackup size={17} /> 백업
        </button>
        <button className="ghost-btn" type="button" onClick={actions.header.openImport} aria-label="책 가져오기">
          <Upload size={17} /> 가져오기
        </button>
        <button
          className="icon-btn"
          type="button"
          onClick={actions.header.openLibraryFolders}
          title="폴더 가져오기"
          aria-label="폴더 가져오기 열기"
        >
          <FolderPlus size={18} />
        </button>
        <button
          className="icon-btn"
          type="button"
          onClick={actions.header.openSettings}
          title="설정"
          aria-label="설정 열기"
        >
          <Settings size={18} />
        </button>
      </div>
    </header>
  );
}

type MobilePanel = 'drawer' | 'display' | 'more' | null;

export interface LibraryMobileSourceMode {
  readonly title: string;
  readonly query: string;
  readonly searchable?: boolean;
  setQuery(value: string): void;
  search(): void;
}

export function LibraryMobileHeader(props: LibraryScreenProps & { sourceMode?: LibraryMobileSourceMode }) {
  const { model, actions } = props;
  const sourceMode = props.sourceMode;
  const [panel, setPanel] = useState<MobilePanel>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shelfOpen, setShelfOpen] = useState(false);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);

  const closeTransient = () => {
    setPanel(null);
    setSearchOpen(false);
    setShelfOpen(false);
  };
  const runGlobal = (action: () => void) => {
    closeTransient();
    window.setTimeout(action, 0);
  };

  return (
    <header className="library-mobile-header">
      <div className="library-mobile-bar">
        <button
          ref={drawerTriggerRef}
          type="button"
          className="library-mobile-icon"
          onClick={() => setPanel('drawer')}
          aria-label="라이브러리 메뉴"
          aria-expanded={panel === 'drawer'}
        >
          <Menu size={20} />
        </button>
        {sourceMode ? (
          <span className="library-mobile-shelf is-static">
            <Cloud size={15} />
            <span>{sourceMode.title}</span>
          </span>
        ) : (
          <button
            type="button"
            className="library-mobile-shelf"
            onClick={() => {
              setPanel(null);
              setSearchOpen(false);
              setShelfOpen((value) => !value);
            }}
            aria-expanded={shelfOpen}
          >
            <Folder size={15} />
            <span>
              {model.management.shelves.find((shelf) => shelf.id === model.management.activeShelfId)?.name ?? '전체'}
            </span>
          </button>
        )}
        <span className="library-mobile-spacer" />
        {!sourceMode && (
          <button
            type="button"
            className="library-mobile-icon"
            onClick={() => {
              setSearchOpen(false);
              setShelfOpen(false);
              setPanel(panel === 'display' ? null : 'display');
            }}
            aria-label="정렬 및 보기"
            aria-expanded={panel === 'display'}
          >
            <ArrowDownUp size={18} />
          </button>
        )}
        {(!sourceMode || sourceMode.searchable !== false) && (
          <button
            type="button"
            className="library-mobile-icon"
            onClick={() => {
              setPanel(null);
              setShelfOpen(false);
              setSearchOpen((value) => !value);
            }}
            aria-label="작품 검색"
            aria-expanded={searchOpen}
          >
            <Search size={19} />
          </button>
        )}
        <button
          type="button"
          className="library-mobile-icon"
          onClick={() => {
            setSearchOpen(false);
            setShelfOpen(false);
            setPanel(panel === 'more' ? null : 'more');
          }}
          aria-label="더보기"
          aria-expanded={panel === 'more'}
        >
          <MoreVertical size={19} />
        </button>
      </div>

      {!sourceMode && shelfOpen && (
        <div className="library-mobile-quick-shelves" role="group" aria-label="책장 빠른 선택">
          <button
            type="button"
            className={!model.management.activeShelfId ? 'active' : ''}
            onClick={() => {
              actions.controls.setShelf(undefined);
              setShelfOpen(false);
            }}
          >
            모든 작품
          </button>
          {model.management.shelves.map((shelf) => (
            <button
              key={shelf.id}
              type="button"
              className={model.management.activeShelfId === shelf.id ? 'active' : ''}
              onClick={() => {
                actions.controls.setShelf(shelf.id);
                setShelfOpen(false);
              }}
            >
              {shelf.name}
            </button>
          ))}
        </div>
      )}

      {searchOpen && (!sourceMode || sourceMode.searchable !== false) && (
        <label className="library-mobile-search">
          <Search size={16} />
          <input
            autoFocus
            type="search"
            value={sourceMode?.query ?? model.query}
            onChange={(event) =>
              sourceMode ? sourceMode.setQuery(event.target.value) : actions.header.setQuery(event.target.value)
            }
            onKeyDown={(event) => {
              if (sourceMode && event.key === 'Enter') sourceMode.search();
            }}
            placeholder={sourceMode ? '현재 소스 검색' : '작품 검색'}
            aria-label={sourceMode ? '모바일 외부 소스 검색' : '모바일 작품 검색'}
          />
          {(sourceMode?.query ?? model.query) && (
            <button
              type="button"
              onClick={() => (sourceMode ? sourceMode.setQuery('') : actions.header.setQuery(''))}
              aria-label="검색어 지우기"
            >
              <X size={15} />
            </button>
          )}
        </label>
      )}

      {(panel === 'display' || panel === 'more') && (
        <button
          type="button"
          className="library-mobile-menu-backdrop"
          onClick={() => setPanel(null)}
          aria-label="메뉴 닫기"
        />
      )}
      {panel === 'display' && (
        <section className="library-mobile-popover library-mobile-display" aria-label="정렬 및 레이아웃">
          <strong>정렬</strong>
          {(
            [
              ['recent', '최근 읽은 순'],
              ['title', '제목 순'],
              ['added', '최근 추가 순'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={model.sort === value ? 'active' : ''}
              onClick={() => {
                actions.controls.setSort(value);
                setPanel(null);
              }}
            >
              {label}
            </button>
          ))}
          <strong>레이아웃</strong>
          <div role="group" aria-label="모바일 보기 방식">
            <button
              type="button"
              className={model.viewMode === 'grid' ? 'active' : ''}
              onClick={() => {
                actions.controls.setViewMode('grid');
                setPanel(null);
              }}
            >
              <Grid2X2 size={16} /> 표지
            </button>
            <button
              type="button"
              className={model.viewMode === 'list' ? 'active' : ''}
              onClick={() => {
                actions.controls.setViewMode('list');
                setPanel(null);
              }}
            >
              <List size={16} /> 목록
            </button>
          </div>
        </section>
      )}
      {panel === 'more' && (
        <section className="library-mobile-popover library-mobile-more" aria-label="추가 작업">
          <button type="button" onClick={() => runGlobal(actions.header.openImport)}>
            <Upload size={17} /> 가져오기
          </button>
          <button type="button" onClick={() => runGlobal(actions.header.openLibraryFolders)}>
            <FolderPlus size={17} /> 폴더 가져오기
          </button>
          {model.management.available && (
            <button type="button" onClick={() => runGlobal(actions.controls.openShelves)}>
              <Plus size={17} /> 책장 추가
            </button>
          )}
          <button type="button" onClick={() => runGlobal(actions.header.openSync)}>
            <RotateCcw size={17} /> 동기화 <small>{model.sync.label}</small>
          </button>
          <button type="button" onClick={() => runGlobal(actions.header.openBackup)}>
            <DatabaseBackup size={17} /> 백업 및 복원
          </button>
          <button type="button" onClick={() => runGlobal(actions.header.openSettings)}>
            <Settings size={17} /> 설정
          </button>
        </section>
      )}

      <ModalDrawer
        open={panel === 'drawer'}
        title={<img src="/branding/moya-wordmark.png" alt="MOYA" />}
        onClose={() => setPanel(null)}
        restoreFocusRef={drawerTriggerRef}
        className="library-mobile-drawer"
        closeLabel="라이브러리 메뉴 닫기"
        footer={
          <>
            <button type="button" onClick={() => runGlobal(actions.header.openImport)}>
              <Upload size={17} /> 가져오기
            </button>
            <button type="button" onClick={() => runGlobal(actions.header.openLibraryFolders)}>
              <FolderPlus size={17} /> 폴더 가져오기
            </button>
            <button type="button" onClick={() => runGlobal(actions.header.openSync)}>
              <RotateCcw size={17} /> 동기화
            </button>
            <button type="button" onClick={() => runGlobal(actions.header.openBackup)}>
              <DatabaseBackup size={17} /> 백업 및 복원
            </button>
            <button type="button" onClick={() => runGlobal(actions.header.openSettings)}>
              <Settings size={17} /> 설정
            </button>
          </>
        }
      >
        <div className="library-mobile-drawer-scroll">
          <h2>라이브러리</h2>
          <FilterNavigation {...props} close={() => setPanel(null)} />
          {model.management.available && (
            <>
              <h2>책장</h2>
              <ShelfNavigation {...props} close={() => setPanel(null)} />
            </>
          )}
          {model.externalSources.sources.length > 0 && (
            <>
              <h2>소스</h2>
              <SourceNavigation {...props} close={() => setPanel(null)} />
            </>
          )}
        </div>
      </ModalDrawer>
    </header>
  );
}
