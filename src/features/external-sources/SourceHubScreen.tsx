import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Check,
  ChevronRight,
  Cloud,
  FileText,
  FilePlus2,
  Folder,
  LoaderCircle,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Settings,
  Upload,
  X,
} from 'lucide-react';
import type { FormEvent } from 'react';
import { externalItemKeyId } from '../../external-sources/contracts';
import { formatBytes, formatCount } from '../../utils/format';
import type { LibraryScreenProps } from '../library/library-screen-contract';
import { LibraryMobileHeader, LibrarySidebar } from '../library/LibraryChrome';
import type {
  ExternalSourceController,
  ExternalSourceImportProgress,
  ExternalSourceItemImportState,
  ExternalSourceItemView,
} from './useExternalSourceController';

export interface SourceHubScreenProps {
  readonly controller: ExternalSourceController;
  readonly library: LibraryScreenProps;
  readonly openSourceSettings: () => void;
}

function importStateLabel(state: ExternalSourceItemImportState): string {
  switch (state) {
    case 'imported':
      return '가져옴';
    case 'update_available':
      return '업데이트 있음';
    case 'unsupported':
      return '지원하지 않음';
    default:
      return '추가 가능';
  }
}

function itemStateLabel(item: ExternalSourceItemView): string {
  if (item.kind === 'work' && item.navigationRef) return '탐색 가능';
  return importStateLabel(item.importState);
}

function canSelectItem(item: ExternalSourceItemView): boolean {
  return (
    item.kind !== 'folder' &&
    item.importability !== 'unsupported' &&
    item.importState !== 'unsupported' &&
    item.importState !== 'imported'
  );
}

function updatedLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' }).format(timestamp);
}

function itemDescription(item: ExternalSourceItemView): string | undefined {
  return (
    [...new Set([item.author, item.subtitle].filter((value): value is string => Boolean(value)))].join(' · ') ||
    undefined
  );
}

function coverLetters(title: string): string {
  const normalized = title.replace(/\.[^.]+$/, '').trim();
  return Array.from(normalized).slice(0, 2).join('').toLocaleUpperCase() || 'MO';
}

function importProgressMessage(progress: ExternalSourceImportProgress, sourceTitle: string): string {
  if (progress.detail?.message) return progress.detail.message;
  switch (progress.phase) {
    case 'downloading':
      return `${sourceTitle}에서 원문을 내려받는 중입니다. 큰 파일은 잠시 걸릴 수 있습니다.`;
    case 'verifying':
      return '다운로드한 원문을 확인하는 중입니다.';
    case 'importing':
      return '작품을 분석해 라이브러리에 저장하는 중입니다.';
    default:
      return '가져오기를 준비하는 중입니다.';
  }
}

function ItemAction({ item, controller }: { item: ExternalSourceItemView; controller: ExternalSourceController }) {
  if (item.kind === 'work' && item.navigationRef) {
    return (
      <button
        className="primary-btn source-hub-card-action"
        type="button"
        disabled={controller.busy || controller.loading}
        onClick={() => void controller.openItem(item)}
      >
        <BookOpen size={15} /> 작품·회차 보기
      </button>
    );
  }
  if (item.importState === 'imported') {
    return (
      <button
        className="ghost-btn source-hub-card-action"
        type="button"
        disabled={controller.busy}
        onClick={() => void controller.openImported(item)}
      >
        <BookOpen size={15} /> 라이브러리에서 보기
      </button>
    );
  }
  if (!canSelectItem(item)) {
    return (
      <button className="ghost-btn source-hub-card-action" type="button" disabled>
        지원하지 않음
      </button>
    );
  }
  return (
    <button
      className="primary-btn source-hub-card-action"
      type="button"
      disabled={controller.busy || controller.loading}
      onClick={() => void controller.importItem(item)}
    >
      {item.importState === 'update_available' ? <RefreshCw size={15} /> : <Upload size={15} />}
      {item.importState === 'update_available' ? '업데이트' : '라이브러리로 추가'}
    </button>
  );
}

function SourceItemCard({ item, controller }: { item: ExternalSourceItemView; controller: ExternalSourceController }) {
  const itemId = externalItemKeyId(item.key);
  const selectable = canSelectItem(item);
  const description = itemDescription(item);
  return (
    <article className="source-hub-card" data-kind={item.kind} data-state={item.importState}>
      <div className="source-hub-card-cover" data-format={(item.formatHint ?? 'book').toLocaleLowerCase()}>
        {item.thumbnailUrl && <img src={item.thumbnailUrl} alt="" referrerPolicy="no-referrer" />}
        <span>{coverLetters(item.title)}</span>
        <small>{item.formatHint ?? (item.kind === 'work' ? '작품' : '파일')}</small>
      </div>
      <div className="source-hub-card-copy">
        <div className="source-hub-card-heading">
          {selectable ? (
            <label className="source-hub-card-select">
              <input
                type="checkbox"
                checked={item.selected}
                disabled={controller.busy}
                aria-label={`${item.title} 선택`}
                onChange={() => controller.toggleItem(itemId)}
              />
            </label>
          ) : (
            <span className="source-hub-card-select" aria-hidden="true" />
          )}
          <div className="source-hub-card-controls">
            <span
              className={`source-hub-state is-${
                item.kind === 'work' && item.navigationRef ? 'available' : item.importState
              }`}
            >
              {item.importState === 'imported' && <Check size={12} />}
              {itemStateLabel(item)}
            </span>
            {controller.canRemoveItems && (
              <button
                type="button"
                className="icon-btn source-hub-card-remove"
                disabled={controller.busy}
                title="선택 목록에서 제거"
                aria-label={`${item.title} 선택 목록에서 제거`}
                onClick={() => void controller.removeItem(item)}
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
        <strong title={item.title}>{item.title}</strong>
        {description && <p>{description}</p>}
        {item.localBookTitle && <p className="source-hub-local-book">라이브러리: {item.localBookTitle}</p>}
        <div className="source-hub-card-meta">
          {item.byteLength !== undefined && <span>{formatBytes(item.byteLength)}</span>}
          {updatedLabel(item.updatedAt) && <span>{updatedLabel(item.updatedAt)}</span>}
        </div>
        <ItemAction item={item} controller={controller} />
      </div>
    </article>
  );
}

export default function SourceHubScreen({ controller, library, openSourceSettings }: SourceHubScreenProps) {
  const activeSource = controller.sources.find((source) => source.id === controller.activeSourceId);
  const folders = controller.items.filter((item) => item.kind === 'folder');
  const contentItems = controller.items.filter((item) => item.kind !== 'folder');
  const selectableItems = contentItems.filter(canSelectItem);
  const selectedCount = selectableItems.filter((item) => item.selected).length;
  const updateCount = contentItems.filter((item) => item.importState === 'update_available').length;
  const selectedUpdateCount = selectableItems.filter(
    (item) => item.selected && item.importState === 'update_available',
  ).length;
  const allSelected = selectableItems.length > 0 && selectedCount === selectableItems.length;
  const isSuwayomi = activeSource?.id.startsWith('moya.external.suwayomi') ?? false;

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!controller.busy) void controller.search();
  };

  if (!activeSource || activeSource.connection.state !== 'connected') return null;

  return (
    <main className="library-screen source-hub-screen" aria-busy={controller.loading}>
      <div className="library-product-shell">
        <LibrarySidebar {...library} />
        <section className="library-workspace">
          <LibraryMobileHeader
            {...library}
            sourceMode={{
              title: activeSource.title,
              query: controller.query,
              searchable: !controller.detail,
              setQuery: controller.setQuery,
              search: () => void controller.search(),
            }}
          />
          <header className="source-hub-topbar">
            <div className="source-hub-topbar-title">
              {activeSource.kind === 'cloud_file' ? <Cloud size={20} /> : <FileText size={20} />}
              <span>
                <strong>{activeSource.title}</strong>
                <small>{activeSource.description ?? '연결된 외부 소스'}</small>
              </span>
            </div>
            {controller.detail ? (
              <div className="source-hub-detail-context">
                <BookOpen size={16} /> 선택한 작품의 회차를 보고 있습니다.
              </div>
            ) : (
              <form className="source-hub-search" role="search" onSubmit={submitSearch}>
                <Search size={17} />
                <input
                  type="search"
                  value={controller.query}
                  disabled={controller.busy}
                  placeholder="현재 소스 검색"
                  aria-label="외부 소스 검색"
                  onChange={(event) => controller.setQuery(event.target.value)}
                />
                <button className="ghost-btn" type="submit" disabled={controller.loading || controller.busy}>
                  검색
                </button>
              </form>
            )}
            <div className="source-hub-topbar-actions">
              <button
                className="ghost-btn"
                type="button"
                disabled={controller.loading || controller.busy}
                onClick={() => void controller.refresh()}
              >
                <RefreshCw size={16} className={controller.loading ? 'spin' : undefined} /> 새로고침
              </button>
              <button
                className="icon-btn"
                type="button"
                disabled={controller.busy}
                title="소스 관리"
                aria-label="소스 관리"
                onClick={openSourceSettings}
              >
                <Settings size={18} />
              </button>
            </div>
          </header>

          <div className="source-hub-scroll">
            <section className="source-hub-hero">
              <div>
                <span className="eyebrow">외부 소스</span>
                <h1>{controller.detail?.title ?? activeSource.title}</h1>
                <p>
                  {controller.detail?.description ??
                    (isSuwayomi
                      ? 'Suwayomi에 설치된 Mihon 소스를 탐색하고, 선택한 회차만 라이브러리로 가져옵니다.'
                      : '목록만 먼저 확인하고, 선택한 파일이나 작품만 내 라이브러리로 가져옵니다.')}
                </p>
                {controller.detail && (
                  <div className="source-hub-work-meta">
                    {[controller.detail.author, controller.detail.artist, controller.detail.status]
                      .filter((value): value is string => Boolean(value))
                      .map((value) => (
                        <span key={value}>{value}</span>
                      ))}
                    {controller.detail.tags?.slice(0, 6).map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="source-hub-hero-actions">
                {controller.canPickItems && (
                  <button
                    type="button"
                    className="primary-btn"
                    disabled={controller.busy || controller.loading}
                    onClick={() => void controller.pickItems()}
                  >
                    {controller.busy ? <LoaderCircle size={15} className="spin" /> : <FilePlus2 size={15} />}
                    Drive에서 파일 추가
                  </button>
                )}
                <span className="source-hub-connection">
                  <Check size={14} /> 연결됨
                </span>
              </div>
            </section>

            {(controller.breadcrumbs.length > 0 || controller.stale) && (
              <div className="source-hub-location">
                {controller.breadcrumbs.length > 1 && (
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={controller.busy}
                    aria-label="상위 폴더"
                    onClick={() => void controller.goBack()}
                  >
                    <ArrowLeft size={17} />
                  </button>
                )}
                <div aria-label="현재 외부 소스 위치">
                  {controller.breadcrumbs.map((crumb, index) => (
                    <span key={`${crumb.parentRef ?? 'root'}:${index}`}>
                      {index > 0 && <ChevronRight size={13} />}
                      {crumb.label}
                    </span>
                  ))}
                </div>
                {controller.currentLocationCanBeDefault && (
                  <button
                    type="button"
                    className="ghost-btn source-hub-default-folder-btn"
                    disabled={controller.busy || controller.loading}
                    aria-label={controller.currentFolderIsDefault ? '기본 폴더 해제' : '현재 폴더를 기본 폴더로 설정'}
                    onClick={() =>
                      void (controller.currentFolderIsDefault
                        ? controller.clearDefaultFolder()
                        : controller.setCurrentFolderAsDefault())
                    }
                  >
                    {controller.currentFolderIsDefault ? <PinOff size={14} /> : <Pin size={14} />}
                    {controller.currentFolderIsDefault ? '기본 폴더 해제' : '기본 폴더로 설정'}
                  </button>
                )}
                {controller.stale && <em>저장된 목록</em>}
              </div>
            )}

            {updateCount > 0 && (
              <div className="source-hub-update-notice" role="status">
                <AlertTriangle size={18} />
                <span>
                  <strong>{formatCount(updateCount)}개 작품에 원격 업데이트가 있습니다.</strong>
                  직접 업데이트하기 전까지 책장의 현재 본문은 유지됩니다.
                </span>
              </div>
            )}

            {controller.detail && isSuwayomi && (
              <div className="source-hub-bridge-notice" role="note">
                <BookOpen size={18} />
                <span>
                  <strong>현재는 회차별로 라이브러리에 추가됩니다.</strong>
                  여러 회차를 하나의 연재 작품으로 묶는 모델과 원격 이어읽기는 다음 단계에서 연결합니다.
                </span>
              </div>
            )}

            {folders.length > 0 && (
              <section className="source-hub-folder-section" aria-labelledby="source-folders-title">
                <div className="source-hub-section-heading">
                  <h2 id="source-folders-title">폴더</h2>
                  <span>{formatCount(folders.length)}개</span>
                </div>
                <div className="source-hub-folder-grid">
                  {folders.map((folder) => (
                    <button
                      key={externalItemKeyId(folder.key)}
                      type="button"
                      disabled={controller.busy}
                      onClick={() => void controller.openFolder(folder)}
                    >
                      <Folder size={20} />
                      <span>{folder.title}</span>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section className="source-hub-items" aria-labelledby="source-items-title">
              <div className="source-hub-section-heading source-hub-items-heading">
                <div>
                  <h2 id="source-items-title">
                    {controller.detail ? '회차' : activeSource.kind === 'catalog' ? '작품' : '파일'}
                  </h2>
                  <span>{formatCount(contentItems.length)}개</span>
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    disabled={selectableItems.length === 0 || controller.busy}
                    onChange={(event) => controller.selectAllSupported(event.target.checked)}
                  />
                  모두 선택
                </label>
              </div>

              {controller.loading && controller.items.length === 0 ? (
                <div className="source-hub-empty" role="status">
                  <LoaderCircle size={24} className="spin" /> 목록을 불러오고 있습니다.
                </div>
              ) : controller.items.length === 0 ? (
                <div className="source-hub-empty">
                  <FileText size={34} />
                  <strong>표시할 파일이나 작품이 없습니다.</strong>
                  <span>
                    {controller.canPickItems
                      ? 'Drive에서 파일 추가를 눌러 연결할 파일을 선택해 보세요.'
                      : '다른 폴더를 열거나 검색어를 변경해 보세요.'}
                  </span>
                </div>
              ) : contentItems.length > 0 ? (
                <div className="source-hub-card-grid" aria-label="외부 소스 작품 목록">
                  {contentItems.map((item) => (
                    <SourceItemCard key={externalItemKeyId(item.key)} item={item} controller={controller} />
                  ))}
                </div>
              ) : null}

              {controller.nextCursor && (
                <button
                  className="source-hub-load-more ghost-btn"
                  type="button"
                  disabled={controller.loading || controller.busy}
                  onClick={() => void controller.loadMore()}
                >
                  {controller.loading && <LoaderCircle size={15} className="spin" />} 더 보기
                </button>
              )}
            </section>
          </div>
        </section>
      </div>

      {(selectedCount > 0 || controller.progress) && (
        <div className="source-hub-batch-bar" role="status" aria-live="polite">
          <div>
            {controller.progress ? (
              <>
                <strong>{controller.progress.fileName ?? '선택한 작품 가져오기'}</strong>
                <span>
                  {controller.progress.current}/{controller.progress.total}
                </span>
                <progress
                  aria-label="외부 작품 가져오기 진행률"
                  max={Math.max(1, controller.progress.total)}
                  value={Math.max(0, controller.progress.current - 1)}
                />
                <span>{importProgressMessage(controller.progress, activeSource.title)}</span>
              </>
            ) : (
              <>
                <strong>{formatCount(selectedCount)}개 선택</strong>
                <span>선택하기 전에는 원문을 내려받지 않습니다.</span>
              </>
            )}
          </div>
          {controller.busy ? (
            <button className="ghost-btn danger" type="button" onClick={controller.cancel}>
              중단
            </button>
          ) : (
            <button className="primary-btn" type="button" onClick={() => void controller.importSelected()}>
              {selectedUpdateCount === selectedCount ? <RefreshCw size={16} /> : <Upload size={16} />}
              {selectedUpdateCount === 0
                ? '선택 항목 가져오기'
                : selectedUpdateCount === selectedCount
                  ? '선택 항목 업데이트'
                  : '선택 항목 가져오기·업데이트'}
            </button>
          )}
        </div>
      )}
    </main>
  );
}
