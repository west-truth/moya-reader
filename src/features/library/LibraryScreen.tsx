import {
  BookOpen,
  Check,
  DatabaseBackup,
  Download,
  FileText,
  Folder,
  FolderCog,
  FolderPlus,
  Library,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Star,
  StarOff,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useDismissibleLayer } from '../../shared/ui/use-dismissible-layer';
import { useMenuPopover } from '../../shared/ui/use-menu-popover';
import { formatBytes, formatCount, formatProgress } from '../../utils/format';
import { BookCover } from './BookCover';
import { LibraryBookCollection } from './LibraryBookCollection';
import { LibraryControls } from './LibraryControls';
import { LibraryReadingProgress } from './LibraryReadingProgress';
import type { LibraryBookView, LibraryFilter } from './library-screen-model';
import type { LibraryScreenProps } from './library-screen-contract';
import { bookFormatLabel, bookUnitLabel, isFixedDocumentFormat } from '../../domain/book-format';

export type { LibraryScreenActions, LibraryScreenModel, LibraryScreenProps } from './library-screen-contract';

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

const systemViews: Array<{
  value: LibraryFilter;
  label: string;
  icon: typeof Library;
}> = [
  { value: 'all', label: '전체', icon: Library },
  { value: 'reading', label: '읽는 중', icon: BookOpen },
  { value: 'finished', label: '완독', icon: Check },
  { value: 'unread', label: '미독', icon: FileText },
  { value: 'favorite', label: '즐겨찾기', icon: Star },
  { value: 'trash', label: '휴지통', icon: Trash2 },
];

function LibraryRail({ model, actions }: LibraryScreenProps) {
  const featuredBook = model.collection.featuredBook;
  return (
    <aside className="library-rail" aria-label="주요 화면">
      <div className="library-rail-brand" aria-label="모야">
        모
      </div>
      <nav className="library-rail-nav">
        <button className="active" type="button" title="라이브러리" aria-label="라이브러리" aria-current="page">
          <Library size={19} />
        </button>
        {featuredBook && (
          <button
            type="button"
            title={`${featuredBook.novel.title} 이어 읽기`}
            aria-label={`${featuredBook.novel.title} 이어 읽기`}
            onClick={() => void actions.books.continueReading(featuredBook.novel)}
          >
            <BookOpen size={19} />
          </button>
        )}
      </nav>
      <button
        className="library-rail-settings"
        type="button"
        title="설정"
        aria-label="설정 열기"
        onClick={actions.header.openSettings}
      >
        <Settings size={19} />
      </button>
    </aside>
  );
}

function LibraryMobileMenu({ model, actions }: LibraryScreenProps) {
  const [open, setOpen] = useState(false);
  const menu = useMenuPopover(open, setOpen);

  const run = (action: () => void) => {
    setOpen(false);
    menu.triggerRef.current?.focus();
    action();
  };
  return (
    <div className="library-mobile-menu" ref={menu.rootRef}>
      <button
        ref={menu.triggerRef}
        type="button"
        className="icon-btn library-mobile-menu-trigger"
        title="책장 메뉴"
        aria-label="책장 메뉴 열기"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div
          ref={menu.menuRef}
          className="library-mobile-menu-popover"
          role="menu"
          aria-label="책장 작업"
          onKeyDown={menu.onMenuKeyDown}
        >
          <button type="button" role="menuitem" onClick={() => run(actions.header.openSync)}>
            <RotateCcw size={16} />
            <span>동기화 상태</span>
            <small>{model.sync.label}</small>
          </button>
          <button type="button" role="menuitem" onClick={() => run(actions.header.openBackup)}>
            <DatabaseBackup size={16} />
            <span>백업 및 복원</span>
          </button>
          <button type="button" role="menuitem" onClick={() => run(actions.header.openLibraryFolders)}>
            <FolderPlus size={16} />
            <span>책장 폴더</span>
          </button>
          <button type="button" role="menuitem" onClick={() => run(actions.header.openSettings)}>
            <Settings size={16} />
            <span>설정</span>
          </button>
        </div>
      )}
    </div>
  );
}

function LibraryHeader({ model, actions }: LibraryScreenProps) {
  return (
    <header className="library-topbar">
      <div className="library-topbar-title">
        <strong>책장</strong>
        <span>{formatCount(model.collection.totalBooks)}권</span>
      </div>
      <label className="search-box library-search">
        <Search size={16} />
        <input
          type="search"
          value={model.query}
          onChange={(event) => actions.header.setQuery(event.target.value)}
          placeholder="책장 검색"
          aria-label="책장 검색"
        />
      </label>
      <div className="library-topbar-actions">
        <button
          className={classNames('sync-pill', model.sync.tone)}
          onClick={actions.header.openSync}
          title="동기화 상태 열기"
          aria-label={`동기화 상태 열기: ${model.sync.label}`}
        >
          <span aria-hidden="true" />
          {model.sync.label}
        </button>
        <button
          className="icon-btn library-backup-btn"
          type="button"
          onClick={actions.header.openBackup}
          title="백업"
          aria-label="백업 및 복원 열기"
        >
          <DatabaseBackup size={18} />
        </button>
        <button
          className="ghost-btn library-import-btn"
          type="button"
          onClick={actions.header.openImport}
          aria-label="책 가져오기"
        >
          <Upload size={17} /> <span>가져오기</span>
        </button>
        <button
          className="icon-btn library-folder-btn"
          type="button"
          onClick={actions.header.openLibraryFolders}
          title="책장 폴더"
          aria-label="책장 폴더 열기"
        >
          <FolderPlus size={18} />
        </button>
        <LibraryMobileMenu model={model} actions={actions} />
      </div>
    </header>
  );
}

function LibrarySidebar({ model, actions }: LibraryScreenProps) {
  const counts = model.collection.filterCounts;
  return (
    <aside className="library-sidebar" aria-label="라이브러리 탐색">
      <section>
        <span className="library-sidebar-label">라이브러리</span>
        <nav className="library-sidebar-list" aria-label="작품 상태">
          {systemViews.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.value}
                type="button"
                className={model.filter === item.value ? 'active' : ''}
                onClick={() => actions.controls.setFilter(item.value)}
                aria-pressed={model.filter === item.value}
              >
                <Icon size={16} />
                <span>{item.label}</span>
                <em>{formatCount(counts[item.value])}</em>
              </button>
            );
          })}
        </nav>
      </section>

      {model.management.available && (
        <section className="library-shelf-section">
          <div className="library-sidebar-section-head">
            <span className="library-sidebar-label">책장</span>
            <button type="button" title="책장 관리" aria-label="책장 관리" onClick={actions.controls.openShelves}>
              <FolderCog size={15} />
            </button>
          </div>
          <nav className="library-sidebar-list" aria-label="사용자 책장">
            <button
              type="button"
              className={!model.management.activeShelfId ? 'active' : ''}
              onClick={() => actions.controls.setShelf(undefined)}
              aria-pressed={!model.management.activeShelfId}
            >
              <Folder size={16} />
              <span>전체 작품</span>
              <em>{formatCount(counts.all)}</em>
            </button>
            {model.management.shelves.map((shelf) => (
              <button
                key={shelf.id}
                type="button"
                className={model.management.activeShelfId === shelf.id ? 'active' : ''}
                onClick={() => actions.controls.setShelf(shelf.id)}
                aria-pressed={model.management.activeShelfId === shelf.id}
              >
                <Folder size={16} />
                <span>{shelf.name}</span>
                <em>{formatCount(model.presentation.shelfBookCounts.get(shelf.id) ?? 0)}</em>
              </button>
            ))}
          </nav>
        </section>
      )}
      <p className="library-local-note">파일과 독서 기록은 이 기기에 저장됩니다.</p>
    </aside>
  );
}

function RecentReadingBand({ model, actions }: LibraryScreenProps) {
  const featuredBook = model.collection.featuredBook;
  if (!featuredBook) return null;

  return (
    <section className="recent-band">
      <BookCover novel={featuredBook.novel} className={classNames('book-cover', featuredBook.coverClass)} />
      <div className="recent-copy">
        <span className="eyebrow">이어 읽기</span>
        <h2>{featuredBook.novel.title}</h2>
        <p>
          {featuredBook.readingPositionLabel} · {formatProgress(featuredBook.chapterProgress)} ·{' '}
          {featuredBook.lastReadLabel}
        </p>
      </div>
      <div className="recent-progress">
        <strong>{formatProgress(featuredBook.chapterProgress)}</strong>
        <LibraryReadingProgress
          novel={featuredBook.novel}
          progress={featuredBook.chapterProgress}
          positionLabel={featuredBook.readingPositionLabel}
          className="progress-track"
        />
      </div>
      <button
        className="primary-btn"
        onClick={() => void actions.books.continueReading(featuredBook.novel)}
        aria-label={`${featuredBook.novel.title} 이어 읽기`}
      >
        <Play size={17} /> <span>이어 읽기</span>
      </button>
    </section>
  );
}

function LibraryInspector({
  book,
  model,
  actions,
}: LibraryScreenProps & {
  book?: LibraryBookView;
}) {
  const inspectorRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const compact = model.presentation.layoutMode === 'compact';
  const compactOpen = compact && model.presentation.inspectorOpen;
  useEffect(() => {
    if (!inspectorRef.current) return;
    if (compact && !compactOpen) inspectorRef.current.setAttribute('inert', '');
    else inspectorRef.current.removeAttribute('inert');
  }, [compact, compactOpen]);
  useDismissibleLayer({
    open: compactOpen,
    modal: true,
    containerRef: inspectorRef,
    initialFocusRef: closeRef,
    onClose: actions.presentation.closeInspector,
  });

  if (!book) {
    return (
      <aside
        ref={inspectorRef}
        className="library-inspector"
        aria-label="선택한 작품"
        aria-hidden={compact ? true : undefined}
      >
        <div className="library-inspector-empty">
          <BookOpen size={24} />
          <p>작품을 선택하면 상세 정보가 표시됩니다.</p>
        </div>
      </aside>
    );
  }

  const { novel } = book;
  const trashed = Boolean(novel.deletedAt);
  const format = bookFormatLabel(novel);
  const fixedDocument = isFixedDocumentFormat(novel.format);
  return (
    <aside
      ref={inspectorRef}
      className={classNames('library-inspector', model.presentation.inspectorOpen && 'is-open')}
      aria-label={`선택한 작품: ${novel.title}`}
      role={compact ? 'dialog' : undefined}
      aria-modal={compact ? true : undefined}
      aria-hidden={compact && !compactOpen ? true : undefined}
      tabIndex={compact ? -1 : undefined}
    >
      <header className="library-inspector-header">
        <span>작품 정보</span>
        <button
          ref={closeRef}
          className="mini-icon-btn library-inspector-close"
          type="button"
          title="작품 정보 닫기"
          aria-label="작품 정보 닫기"
          onClick={actions.presentation.closeInspector}
        >
          <X size={16} />
        </button>
      </header>
      <div className="library-inspector-scroll">
        <BookCover novel={novel} className={classNames('book-cover library-inspector-cover', book.coverClass)} />
        <div className="library-inspector-title">
          <span>{trashed ? '휴지통' : book.readingStatusLabel}</span>
          <h2>{novel.title}</h2>
          <p>{[novel.author, novel.seriesTitle].filter(Boolean).join(' · ') || '작가 정보 없음'}</p>
        </div>

        {!trashed && (
          <>
            <div className="library-inspector-progress">
              <div>
                <span>{book.readingPositionLabel}</span>
                <strong>{formatProgress(book.chapterProgress)}</strong>
              </div>
              <LibraryReadingProgress
                novel={novel}
                progress={book.chapterProgress}
                positionLabel={book.readingPositionLabel}
                className="progress-track"
              />
              <small>{book.lastReadLabel}</small>
            </div>
            <button className="primary-btn wide" onClick={() => void actions.books.continueReading(novel)}>
              <Play size={17} /> 이어 읽기
            </button>
            <div className="library-inspector-actions">
              <button className="ghost-btn" onClick={() => void actions.books.open(novel)}>
                <BookOpen size={16} /> {fixedDocument ? '문서 열기' : '화 목록'}
              </button>
              <button
                className={classNames('ghost-btn', novel.favorite && 'active')}
                onClick={() => void actions.books.toggleFavorite(novel)}
                aria-pressed={novel.favorite}
              >
                <Star size={16} fill={novel.favorite ? 'currentColor' : 'none'} /> 즐겨찾기
              </button>
              <button className="ghost-btn" onClick={() => actions.books.editMetadata(novel)}>
                <Pencil size={16} /> 정보 편집
              </button>
              <button
                className="ghost-btn"
                onClick={() => void actions.books.downloadSource(novel)}
                disabled={!novel.sourceAssetId}
                title={novel.sourceAssetId ? novel.sourceFileName : '보관된 원본 파일이 없습니다.'}
                aria-label={`${novel.title} 원본 파일 다운로드`}
              >
                <Download size={16} /> 원본 다운로드
              </button>
            </div>
          </>
        )}

        {trashed && (
          <div className="library-inspector-actions">
            <button className="ghost-btn" onClick={() => void actions.books.restore(novel)}>
              <RotateCcw size={16} /> 복원
            </button>
            <button className="ghost-btn danger" onClick={() => void actions.books.purge(novel)}>
              <Trash2 size={16} /> 영구 삭제
            </button>
          </div>
        )}

        <dl className="library-inspector-details">
          <div>
            <dt>원본 파일</dt>
            <dd title={novel.sourceFileName}>{novel.sourceFileName}</dd>
          </div>
          {novel.sourceByteLength !== undefined && (
            <div>
              <dt>원본 크기</dt>
              <dd>{formatBytes(novel.sourceByteLength)}</dd>
            </div>
          )}
          <div>
            <dt>형식</dt>
            <dd>{format}</dd>
          </div>
          <div>
            <dt>{bookUnitLabel(novel)}</dt>
            <dd>{formatCount(novel.totalChapters)}개</dd>
          </div>
          {!fixedDocument && (
            <>
              <div>
                <dt>문단</dt>
                <dd>{formatCount(novel.totalParagraphs)}개</dd>
              </div>
              <div>
                <dt>분량</dt>
                <dd>{formatCount(novel.totalCharacters)}자</dd>
              </div>
            </>
          )}
          <div>
            <dt>누적 독서</dt>
            <dd>{book.readingTimeLabel}</dd>
          </div>
          {!fixedDocument && (
            <div>
              <dt>인코딩</dt>
              <dd>{novel.sourceEncoding?.toUpperCase() ?? '자동'}</dd>
            </div>
          )}
        </dl>

        {novel.tags && novel.tags.length > 0 && (
          <div className="library-inspector-tags" aria-label="작품 태그">
            {novel.tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        )}
        {novel.description && <p className="library-inspector-description">{novel.description}</p>}
      </div>
    </aside>
  );
}

function ActiveLibraryBatchBar({ model, actions }: LibraryScreenProps) {
  const [shelfId, setShelfId] = useState(model.management.activeShelfId ?? model.management.shelves[0]?.id ?? '');
  const [tag, setTag] = useState('');
  const disabled = model.management.selectedBookIds.size === 0 || model.management.busy;
  return (
    <div className="library-batch-bar" role="toolbar" aria-label="선택한 책 일괄 작업">
      <strong>{model.management.selectedBookIds.size}권</strong>
      {model.management.shelves.length > 0 && (
        <div className="library-batch-group">
          <select value={shelfId} aria-label="일괄 작업 책장" onChange={(event) => setShelfId(event.target.value)}>
            {model.management.shelves.map((shelf) => (
              <option key={shelf.id} value={shelf.id}>
                {shelf.name}
              </option>
            ))}
          </select>
          <button
            className="ghost-btn"
            disabled={disabled || !shelfId}
            onClick={() => void actions.controls.applyBatch({ kind: 'add_to_shelf', shelfId })}
          >
            <FolderPlus size={16} /> 추가
          </button>
          <button
            className="ghost-btn"
            disabled={disabled || !shelfId}
            onClick={() => void actions.controls.applyBatch({ kind: 'remove_from_shelf', shelfId })}
          >
            책장 제외
          </button>
        </div>
      )}
      <div className="library-batch-group">
        <label className="batch-tag-input">
          <Tag size={15} />
          <input value={tag} maxLength={80} aria-label="일괄 태그" onChange={(event) => setTag(event.target.value)} />
        </label>
        <button
          className="ghost-btn"
          disabled={disabled || !tag.trim()}
          onClick={() => void actions.controls.applyBatch({ kind: 'add_tag', tag })}
        >
          태그 추가
        </button>
        <button
          className="ghost-btn"
          disabled={disabled || !tag.trim()}
          onClick={() => void actions.controls.applyBatch({ kind: 'remove_tag', tag })}
        >
          태그 제거
        </button>
      </div>
      <button
        className="icon-btn"
        disabled={disabled}
        title="즐겨찾기 설정"
        aria-label="선택한 책 즐겨찾기 설정"
        onClick={() => void actions.controls.applyBatch({ kind: 'set_favorite', favorite: true })}
      >
        <Star size={17} />
      </button>
      <button
        className="icon-btn"
        disabled={disabled}
        title="즐겨찾기 해제"
        aria-label="선택한 책 즐겨찾기 해제"
        onClick={() => void actions.controls.applyBatch({ kind: 'set_favorite', favorite: false })}
      >
        <StarOff size={17} />
      </button>
      <button
        className="icon-btn"
        disabled={disabled}
        title="책 정보 내보내기"
        aria-label="선택한 책 정보 내보내기"
        onClick={actions.controls.exportSelectedMetadata}
      >
        <Download size={17} />
      </button>
      <button
        className="ghost-btn danger"
        disabled={disabled}
        onClick={() =>
          void actions.controls.applyBatch(
            model.filter === 'trash' ? { kind: 'restore_from_trash' } : { kind: 'move_to_trash' },
          )
        }
      >
        {model.filter === 'trash' ? <RotateCcw size={16} /> : <Trash2 size={16} />}
        {model.filter === 'trash' ? '복원' : '휴지통'}
      </button>
    </div>
  );
}

function LibraryBatchBar(props: LibraryScreenProps) {
  return props.model.management.selectionMode ? <ActiveLibraryBatchBar {...props} /> : null;
}

function LibraryEmptyState({ model, actions }: LibraryScreenProps) {
  if (model.collection.totalBooks > 0) {
    return (
      <div className="empty-state">
        <Search size={36} />
        <h2>조건에 맞는 책이 없습니다</h2>
        <p>검색어를 지우거나 전체 책장으로 돌아가세요.</p>
        <div className="empty-actions">
          <button className="ghost-btn" onClick={() => actions.header.setQuery('')} disabled={!model.query.trim()}>
            검색어 지우기
          </button>
          <button className="primary-btn" onClick={() => actions.controls.setFilter('all')}>
            <Library size={18} /> 전체 보기
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="empty-state"
      onDrop={actions.drag.dropOnEmptyState}
      onDragOver={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
    >
      <FileText size={40} />
      <h2>읽을 파일을 책장에 추가하세요</h2>
      <p>TXT, Markdown, EPUB, PDF와 ZIP/CBZ, RAR/CBR, 7z/CB7 이미지 archive를 지원합니다.</p>
      <div className="empty-actions">
        <button className="primary-btn" onClick={actions.header.openImport}>
          <Upload size={18} /> 파일 가져오기
        </button>
        <button className="ghost-btn" onClick={() => void actions.books.addSample()}>
          <Plus size={18} /> 샘플 추가
        </button>
      </div>
    </div>
  );
}

function LibraryBootstrapState({ model, actions }: LibraryScreenProps) {
  if (model.bootstrap.status === 'loading') {
    return (
      <div className="library-bootstrap-state" role="status" aria-live="polite">
        <div className="library-bootstrap-mark" aria-hidden="true" />
        <h2>책장을 불러오는 중입니다</h2>
        <p>이 기기에 저장된 작품과 읽기 상태를 확인하고 있습니다.</p>
      </div>
    );
  }
  if (model.bootstrap.status === 'failed') {
    return (
      <div className="library-bootstrap-state is-error" role="alert">
        <FileText size={36} aria-hidden="true" />
        <h2>책장을 불러오지 못했습니다</h2>
        <p>{model.bootstrap.message ?? '저장소 상태를 확인한 뒤 다시 시도하세요.'}</p>
        <button type="button" className="primary-btn" onClick={actions.header.retryBootstrap}>
          <RotateCcw size={17} />
          다시 시도
        </button>
      </div>
    );
  }
  return null;
}

export function LibraryScreen({ model, actions }: LibraryScreenProps) {
  const focusedBook = model.presentation.focusedBookId
    ? model.collection.booksByNovelId.get(model.presentation.focusedBookId)
    : undefined;

  return (
    <main
      className={classNames('library-screen', model.drop.active && 'is-drop-active')}
      data-layout-mode={model.presentation.layoutMode}
      aria-busy={model.bootstrap.status === 'loading'}
      onDragEnter={actions.drag.enter}
      onDragOver={actions.drag.over}
      onDragLeave={actions.drag.leave}
      onDrop={actions.drag.drop}
    >
      {model.drop.active && (
        <div className="library-drop-overlay" aria-hidden="true">
          <div>
            <Upload size={26} />
            <strong>{model.drop.importBusy ? '가져오는 중' : '지원하는 책 파일 놓기'}</strong>
            <span>{model.drop.importBusy ? '현재 작업이 끝난 뒤 추가하세요.' : '책장에 바로 추가합니다.'}</span>
          </div>
        </div>
      )}
      <div className="library-product-shell">
        <LibraryRail model={model} actions={actions} />
        <section className="library-workspace">
          <LibraryHeader model={model} actions={actions} />
          <div className="library-layout">
            <LibrarySidebar model={model} actions={actions} />
            <section className="library-main">
              {model.bootstrap.status !== 'ready' ? (
                <LibraryBootstrapState model={model} actions={actions} />
              ) : (
                <>
                  <RecentReadingBand model={model} actions={actions} />
                  <LibraryControls model={model} actions={actions} />
                  {model.collection.visibleBooks.length === 0 ? (
                    <LibraryEmptyState model={model} actions={actions} />
                  ) : (
                    <LibraryBookCollection model={model} actions={actions} />
                  )}
                </>
              )}
            </section>
            {model.presentation.layoutMode === 'compact' && model.presentation.inspectorOpen && (
              <button
                className="library-inspector-backdrop"
                type="button"
                aria-label="작품 정보 닫기"
                onClick={actions.presentation.closeInspector}
              />
            )}
            <LibraryInspector book={focusedBook} model={model} actions={actions} />
          </div>
        </section>
      </div>
      <LibraryBatchBar model={model} actions={actions} />
    </main>
  );
}
