import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  BookOpen,
  Check,
  ChevronRight,
  Cloud,
  Download,
  FileText,
  FilePenLine,
  FilePlus2,
  Folder,
  LoaderCircle,
  ListChecks,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Star,
  Tags,
  Upload,
  X,
} from 'lucide-react';
import { useLayoutEffect, useRef, type FormEvent } from 'react';
import type { Novel } from '../../domain/types';
import type { ExternalSourceFilterDefinition, ExternalSourceFilterValue } from '../../external-sources/contracts';
import { externalItemKeyId } from '../../external-sources/contracts';
import { formatBytes, formatCount } from '../../utils/format';
import type { LibraryScreenProps } from '../library/library-screen-contract';
import { LibraryMobileHeader, LibrarySidebar } from '../library/LibraryChrome';
import { BookCover } from '../library/BookCover';
import { importTaskIsActive, importTaskLabel } from '../import/import-task-projection';
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
  readonly openLocalSeriesImport?: (novel: Novel) => void;
  readonly localSeriesNovel?: Novel;
  readonly localSeriesTitleEditor?: {
    readonly editing: boolean;
    readonly draft: string;
    start(): void;
    cancel(): void;
    setDraft(value: string): void;
    save(): void | Promise<void>;
  };
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

function releaseReadingStateLabel(item: ExternalSourceItemView): string | undefined {
  if (item.readingState === 'current') return '읽는 중';
  if (item.readingState === 'read') return '읽음';
  if (item.readingState === 'unread') return '안 읽음';
  return undefined;
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

function sourceFileExtension(fileName: string | undefined): string {
  const leafName = fileName?.split(/[\\/]/u).at(-1)?.trim();
  const extension = leafName?.match(/\.([^.]+)$/u)?.[1]?.trim();
  return extension ? extension.toLocaleUpperCase() : '압축 파일';
}

function itemDescription(item: ExternalSourceItemView): string | undefined {
  return (
    [...new Set([item.author, item.subtitle].filter((value): value is string => Boolean(value)))].join(' · ') ||
    undefined
  );
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

function ItemAction({
  item,
  controller,
  releaseList = false,
}: {
  item: ExternalSourceItemView;
  controller: ExternalSourceController;
  releaseList?: boolean;
}) {
  const task = controller.tasks.find((candidate) => candidate.externalItemKey === externalItemKeyId(item.key));
  if (releaseList) {
    if (task && importTaskIsActive(task)) {
      return (
        <button
          className="icon-btn source-hub-release-action"
          type="button"
          disabled
          title={importTaskLabel(task)}
          aria-label={`${item.title} ${importTaskLabel(task)}`}
        >
          <LoaderCircle size={16} className={task.phase === 'queued' ? undefined : 'spin'} />
        </button>
      );
    }
    if (task?.phase === 'failed') {
      return (
        <button
          className="icon-btn source-hub-release-action"
          type="button"
          disabled={controller.busy || controller.loading}
          title="다시 시도"
          aria-label={`${item.title} 다시 시도`}
          onClick={() => void controller.importItem(item)}
        >
          <RotateCcw size={16} />
        </button>
      );
    }
    if (item.importState === 'imported') {
      return (
        <button
          className="icon-btn source-hub-release-action"
          type="button"
          disabled={controller.blockingBusy}
          title="회차 보기"
          aria-label={`${item.title} 보기`}
          onClick={() => void controller.openImported(item)}
        >
          <BookOpen size={16} />
        </button>
      );
    }
    if (!canSelectItem(item)) {
      return (
        <button className="icon-btn source-hub-release-action" type="button" disabled title="지원하지 않음">
          <X size={16} />
        </button>
      );
    }
    const updating = item.importState === 'update_available';
    const label = updating ? `${item.title} 업데이트` : `${item.title} 다운로드 후 보기`;
    return (
      <button
        className="icon-btn source-hub-release-action"
        type="button"
        disabled={controller.busy || controller.loading}
        title={updating ? '업데이트' : '다운로드 후 보기'}
        aria-label={label}
        onClick={() => void (updating ? controller.importItem(item) : controller.importAndOpen(item))}
      >
        {updating ? <RefreshCw size={16} /> : <Download size={16} />}
      </button>
    );
  }
  if (item.importState === 'imported') {
    return (
      <button
        className="ghost-btn source-hub-card-action"
        type="button"
        disabled={controller.blockingBusy}
        onClick={() => void controller.openImported(item)}
      >
        <BookOpen size={15} /> {releaseList ? '보기' : '라이브러리에서 보기'}
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
      onClick={() =>
        void (releaseList && item.importState === 'available'
          ? controller.importAndOpen(item)
          : controller.importItem(item))
      }
    >
      {item.importState === 'update_available' ? <RefreshCw size={15} /> : <Upload size={15} />}
      {item.importState === 'update_available' ? '업데이트' : releaseList ? '다운로드 후 보기' : '라이브러리로 추가'}
    </button>
  );
}

function WorkItemActions({
  item,
  controller,
  libraryAddEnabled,
}: {
  item: ExternalSourceItemView;
  controller: ExternalSourceController;
  libraryAddEnabled: boolean;
}) {
  if (!libraryAddEnabled) return null;
  const added = controller.isWorkInLibrary(item);
  return (
    <div className="source-hub-card-actions">
      <button
        className={added ? 'ghost-btn source-hub-card-action' : 'primary-btn source-hub-card-action'}
        type="button"
        disabled={controller.busy || controller.loading || added}
        onClick={() => void controller.addWorkToLibrary(item)}
      >
        {added ? <Check size={15} /> : <Plus size={15} />}
        {added ? '라이브러리 추가됨' : '라이브러리 추가'}
      </button>
    </div>
  );
}

function SourceReleaseRow({
  item,
  controller,
}: {
  item: ExternalSourceItemView;
  controller: ExternalSourceController;
}) {
  const itemId = externalItemKeyId(item.key);
  const task = controller.tasks.find((candidate) => candidate.externalItemKey === itemId);
  const selectable = canSelectItem(item);
  const readingStateLabel = releaseReadingStateLabel(item);
  return (
    <article
      className={`source-hub-release-row${item.readingState ? ` is-${item.readingState}` : ''}`}
      data-state={item.importState}
      data-reading-state={item.readingState}
      aria-current={item.readingState === 'current' ? 'location' : undefined}
      aria-label={`${item.title}, ${task ? importTaskLabel(task) : (readingStateLabel ?? importStateLabel(item.importState))}`}
    >
      <label className="source-hub-release-select">
        {selectable ? (
          <input
            type="checkbox"
            checked={item.selected}
            disabled={controller.busy}
            aria-label={`${item.title} 선택`}
            onChange={() => controller.toggleItem(itemId)}
          />
        ) : (
          <span aria-hidden="true" />
        )}
      </label>
      <span className="source-hub-release-index">
        {item.release?.chapterNumber !== undefined
          ? `${item.release.chapterNumber}화`
          : item.release?.sourceOrder !== undefined
            ? `${item.release.sourceOrder}화`
            : '—'}
      </span>
      <div className="source-hub-release-copy">
        <strong>{item.title}</strong>
        <div>
          {item.subtitle && <span>{item.subtitle}</span>}
          {item.collection?.sourceLabel && <span>{item.collection.sourceLabel}</span>}
        </div>
      </div>
      <span className="source-hub-release-updated">{updatedLabel(item.updatedAt) ?? '—'}</span>
      <span className={`source-hub-state is-${task?.phase ?? item.readingState ?? item.importState}`}>
        {task && importTaskIsActive(task) ? (
          <LoaderCircle size={12} className={task.phase === 'queued' ? undefined : 'spin'} />
        ) : item.readingState === 'current' ? (
          <Play size={11} fill="currentColor" />
        ) : item.readingState === 'read' || (!item.readingState && item.importState === 'imported') ? (
          <Check size={12} />
        ) : null}
        {task ? importTaskLabel(task) : (readingStateLabel ?? importStateLabel(item.importState))}
      </span>
      <ItemAction item={item} controller={controller} releaseList />
    </article>
  );
}

function SourceItemCard({
  item,
  controller,
  libraryAddEnabled,
}: {
  item: ExternalSourceItemView;
  controller: ExternalSourceController;
  libraryAddEnabled: boolean;
}) {
  const itemId = externalItemKeyId(item.key);
  const selectable = canSelectItem(item);
  const description = itemDescription(item);
  const browsableWork = item.kind === 'work' && Boolean(item.navigationRef);
  return (
    <article className="source-hub-card" data-kind={item.kind} data-state={item.importState}>
      {browsableWork && (
        <button
          type="button"
          className="source-hub-card-open"
          disabled={controller.blockingBusy || controller.loading}
          aria-label={`${item.title} 작품 상세 열기`}
          onClick={() => void controller.openItem(item)}
        />
      )}
      <div className="source-hub-card-cover" data-format={(item.formatHint ?? 'book').toLocaleLowerCase()}>
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt="" referrerPolicy="no-referrer" />
        ) : item.kind === 'work' ? (
          <BookOpen size={28} aria-hidden="true" />
        ) : (
          <FileText size={28} aria-hidden="true" />
        )}
      </div>
      <div className="source-hub-card-copy">
        {(!browsableWork || controller.canRemoveItems) && (
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
              {!browsableWork && (
                <span className={`source-hub-state is-${item.importState}`}>
                  {item.importState === 'imported' && <Check size={12} />}
                  {itemStateLabel(item)}
                </span>
              )}
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
        )}
        <strong title={item.title}>{item.title}</strong>
        {description && <p>{description}</p>}
        {item.localBookTitle && <p className="source-hub-local-book">라이브러리: {item.localBookTitle}</p>}
        <div className="source-hub-card-meta">
          {item.formatHint && <span>{item.formatHint}</span>}
          {item.byteLength !== undefined && <span>{formatBytes(item.byteLength)}</span>}
          {updatedLabel(item.updatedAt) && <span>{updatedLabel(item.updatedAt)}</span>}
        </div>
        {item.kind === 'work' && item.navigationRef ? (
          <WorkItemActions item={item} controller={controller} libraryAddEnabled={libraryAddEnabled} />
        ) : (
          <ItemAction item={item} controller={controller} />
        )}
      </div>
    </article>
  );
}

function FilterControl({
  definition,
  value,
  setValue,
}: {
  definition: ExternalSourceFilterDefinition;
  value: ExternalSourceFilterValue | undefined;
  setValue(value: ExternalSourceFilterValue): void;
}) {
  if (definition.kind === 'header') return <strong className="source-hub-filter-header">{definition.label}</strong>;
  if (definition.kind === 'separator') return <hr className="source-hub-filter-separator" />;
  if (definition.kind === 'checkbox') {
    return (
      <label className="source-hub-filter-checkbox">
        <input
          type="checkbox"
          checked={typeof value === 'boolean' ? value : definition.defaultValue}
          onChange={(event) => setValue(event.target.checked)}
        />
        <span>{definition.label}</span>
      </label>
    );
  }
  if (definition.kind === 'text') {
    return (
      <label className="source-hub-filter-field">
        <span>{definition.label}</span>
        <input
          type="text"
          value={typeof value === 'string' ? value : definition.defaultValue}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
    );
  }
  if (definition.kind === 'tri_state') {
    return (
      <label className="source-hub-filter-field">
        <span>{definition.label}</span>
        <select
          value={typeof value === 'string' ? value : definition.defaultValue}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="IGNORE">상관없음</option>
          <option value="INCLUDE">포함</option>
          <option value="EXCLUDE">제외</option>
        </select>
      </label>
    );
  }
  if (definition.kind === 'sort') {
    const selected = typeof value === 'object' && value !== null && 'index' in value ? value : definition.defaultValue;
    return (
      <div className="source-hub-filter-field source-hub-filter-sort">
        <label>
          <span>{definition.label}</span>
          <select
            value={selected.index}
            onChange={(event) => setValue({ ...selected, index: Number(event.target.value) })}
          >
            {definition.options.map((option, index) => (
              <option key={option} value={index}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="ghost-btn"
          aria-label={`${definition.label} ${selected.ascending ? '오름차순' : '내림차순'}`}
          onClick={() => setValue({ ...selected, ascending: !selected.ascending })}
        >
          {selected.ascending ? '오름차순' : '내림차순'}
        </button>
      </div>
    );
  }
  const selected = typeof value === 'number' ? value : definition.defaultValue;
  return (
    <label className="source-hub-filter-field">
      <span>{definition.label}</span>
      <select value={selected} onChange={(event) => setValue(Number(event.target.value))}>
        {definition.options.map((option, index) => (
          <option key={option} value={index}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function SourceHubScreen({
  controller,
  library,
  openSourceSettings,
  openLocalSeriesImport,
  localSeriesNovel,
  localSeriesTitleEditor,
}: SourceHubScreenProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const seriesNovel = localSeriesNovel ?? controller.localSeriesNovel;
  const activeSource = controller.sources.find((source) =>
    seriesNovel ? source.id === controller.localSeriesSourceId : source.id === controller.activeSourceId,
  );
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
  const releaseList = Boolean(controller.detail && contentItems.some((item) => item.release));
  const hasWorkHero = Boolean(seriesNovel || controller.detail);
  const connected = activeSource?.connection.state === 'connected';
  const workTitle = seriesNovel?.title ?? controller.detail?.title ?? '연재 작품';
  const workByline = [
    controller.detail?.author ?? seriesNovel?.author,
    controller.detail?.artist,
    controller.detail?.status,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
  const workSourceLabel = controller.detail?.sourceLabel ?? activeSource?.title ?? '로컬 라이브러리';
  const seriesLibraryBook = seriesNovel ? library.model.collection.booksByNovelId?.get(seriesNovel.id) : undefined;
  const seriesReadingStatus =
    seriesLibraryBook?.readingStatusLabel ??
    (seriesNovel
      ? seriesNovel.lastReadAt || seriesNovel.lastReadProgress > 0
        ? seriesNovel.lastReadProgress >= 1
          ? '완독'
          : '읽는 중'
        : '미독'
      : undefined);
  const seriesCanContinue = seriesLibraryBook ? !seriesLibraryBook.isUnread : seriesReadingStatus !== '미독';
  const localArchiveFormat = seriesNovel ? sourceFileExtension(seriesNovel.sourceFileName) : undefined;
  const sourceSubscriptions = activeSource
    ? controller.subscriptions.filter(
        (subscription) =>
          subscription.connectorId === activeSource.id &&
          (subscription.accountConnectionId ?? '') === (activeSource.connection.accountConnectionId ?? ''),
      )
    : [];

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!controller.blockingBusy) void controller.search();
  };

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.scrollTop = 0;
    const frame = window.requestAnimationFrame(() => {
      scroll.scrollTop = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [controller.activeSourceId, controller.detail?.title, seriesNovel?.id]);

  if (!seriesNovel && (!activeSource || !connected)) return null;

  return (
    <main className="library-screen source-hub-screen" aria-busy={controller.loading}>
      <div className="library-product-shell">
        <LibrarySidebar {...library} />
        <section className="library-workspace">
          <LibraryMobileHeader
            {...library}
            sourceMode={{
              title: seriesNovel?.title ?? activeSource?.title ?? '연재 작품',
              query: controller.query,
              searchable: !controller.detail && Boolean(activeSource),
              setQuery: controller.setQuery,
              search: () => void controller.search(),
            }}
          />
          <header className="source-hub-topbar">
            <div className="source-hub-topbar-title">
              {activeSource?.kind === 'cloud_file' ? <Cloud size={20} /> : <FileText size={20} />}
              <span>
                <strong>{seriesNovel ? '작품 상세' : activeSource?.title}</strong>
                <small>
                  {seriesNovel
                    ? connected
                      ? `${activeSource?.title ?? '외부 소스'}의 회차와 로컬 회차를 함께 표시합니다.`
                      : '다운로드한 로컬 회차를 표시합니다.'
                    : (activeSource?.description ?? '연결된 외부 소스')}
                </small>
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
                  disabled={controller.blockingBusy}
                  placeholder="현재 소스 검색"
                  aria-label="외부 소스 검색"
                  onChange={(event) => controller.setQuery(event.target.value)}
                />
                <button className="ghost-btn" type="submit" disabled={controller.loading || controller.blockingBusy}>
                  검색
                </button>
              </form>
            )}
            <div className="source-hub-topbar-actions">
              {(seriesNovel || controller.busy) && (
                <button className="ghost-btn" type="button" onClick={controller.close}>
                  <ArrowLeft size={16} /> 라이브러리
                </button>
              )}
              {connected && (
                <button
                  className="ghost-btn"
                  type="button"
                  disabled={controller.loading || controller.blockingBusy}
                  onClick={() => void controller.refresh()}
                >
                  <RefreshCw size={16} className={controller.loading ? 'spin' : undefined} /> 새로고침
                </button>
              )}
              {activeSource && (
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
              )}
            </div>
          </header>

          <div ref={scrollRef} className={`source-hub-scroll${hasWorkHero ? ' is-work-detail' : ''}`}>
            {hasWorkHero ? (
              <section className="book-detail-hero source-hub-book-detail" aria-labelledby="source-work-title">
                <button
                  type="button"
                  className="detail-back-button"
                  disabled={controller.blockingBusy && !seriesNovel}
                  onClick={() => void (seriesNovel ? controller.close() : controller.goBack())}
                >
                  <ArrowLeft size={17} /> {seriesNovel ? '서재로' : '소스로'}
                </button>
                <div className="detail-hero-body">
                  <div className="detail-hero-cover">
                    {seriesNovel ? (
                      <BookCover novel={seriesNovel} className="book-cover source-hub-detail-cover" />
                    ) : (
                      <div className="book-cover source-hub-detail-cover source-hub-remote-cover">
                        {controller.detail?.thumbnailUrl ? (
                          <img src={controller.detail.thumbnailUrl} alt="" referrerPolicy="no-referrer" />
                        ) : (
                          <BookOpen size={36} aria-hidden="true" />
                        )}
                      </div>
                    )}
                  </div>
                  <div className="detail-hero-copy">
                    <span className="detail-status">{seriesReadingStatus ?? workSourceLabel}</span>
                    {seriesNovel && localSeriesTitleEditor?.editing ? (
                      <form
                        id="book-title-editor"
                        className="book-title-editor"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void localSeriesTitleEditor.save();
                        }}
                      >
                        <input
                          value={localSeriesTitleEditor.draft}
                          onChange={(event) => localSeriesTitleEditor.setDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              localSeriesTitleEditor.cancel();
                            }
                          }}
                          autoFocus
                          maxLength={120}
                          aria-label="책 제목"
                        />
                        <button type="submit" title="저장" aria-label="책 제목 저장">
                          <Check size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={localSeriesTitleEditor.cancel}
                          title="취소"
                          aria-label="책 제목 수정 취소"
                        >
                          <X size={15} />
                        </button>
                      </form>
                    ) : (
                      <h1 id="source-work-title">{workTitle}</h1>
                    )}
                    {workByline && <p className="detail-byline">{workByline}</p>}
                    {(controller.detail?.description ?? seriesNovel?.description) && (
                      <p className="detail-description">{controller.detail?.description ?? seriesNovel?.description}</p>
                    )}
                    {controller.detail?.tags && controller.detail.tags.length > 0 && (
                      <div className="detail-tags" aria-label="작품 태그">
                        <Tags size={14} />
                        {controller.detail.tags.slice(0, 8).map((tag) => (
                          <span key={tag}>#{tag}</span>
                        ))}
                      </div>
                    )}
                    <div className="detail-hero-actions">
                      {seriesNovel && (
                        <button
                          type="button"
                          className="primary-btn"
                          disabled={controller.blockingBusy || controller.loading}
                          onClick={() => void library.actions.books.continueReading(seriesNovel)}
                        >
                          <Play size={16} fill="currentColor" />
                          {seriesCanContinue ? '이어 보기' : '첫 회차 보기'}
                        </button>
                      )}
                      {controller.canSubscribeCurrentWork && !controller.activeSubscription && (
                        <button
                          type="button"
                          className="primary-btn"
                          disabled={controller.busy || controller.loading}
                          onClick={() => void controller.addCurrentWorkToLibrary()}
                        >
                          <Plus size={15} /> 라이브러리에 추가
                        </button>
                      )}
                      {controller.activeSubscription && (
                        <button
                          type="button"
                          disabled={controller.busy || controller.loading}
                          onClick={() => void controller.removeLibraryWork(controller.activeSubscription!)}
                        >
                          <X size={15} /> 라이브러리에서 제거
                        </button>
                      )}
                      {seriesNovel && (
                        <button
                          type="button"
                          className={seriesNovel.favorite ? 'is-favorite' : ''}
                          disabled={controller.busy || controller.loading}
                          aria-pressed={seriesNovel.favorite}
                          onClick={() => void library.actions.books.toggleFavorite(seriesNovel)}
                        >
                          <Star size={17} fill={seriesNovel.favorite ? 'currentColor' : 'none'} /> 즐겨찾기
                        </button>
                      )}
                      {seriesNovel && (
                        <button
                          type="button"
                          className="detail-edit-button"
                          disabled={controller.busy || controller.loading}
                          onClick={() => library.actions.books.editMetadata(seriesNovel)}
                        >
                          <FilePenLine size={17} /> 편집
                        </button>
                      )}
                      {seriesNovel && openLocalSeriesImport && (
                        <button
                          type="button"
                          className="source-hub-local-release-add"
                          disabled={controller.busy || controller.loading}
                          title="로컬 회차 추가"
                          aria-label="로컬 회차 추가"
                          onClick={() => openLocalSeriesImport(seriesNovel)}
                        >
                          <Plus size={17} /> 회차 추가
                        </button>
                      )}
                      {seriesNovel && localSeriesTitleEditor && (
                        <button
                          type="button"
                          className={
                            localSeriesTitleEditor.editing ? 'detail-title-button is-active' : 'detail-title-button'
                          }
                          disabled={controller.busy || controller.loading}
                          aria-controls="book-title-editor"
                          aria-expanded={localSeriesTitleEditor.editing}
                          onClick={
                            localSeriesTitleEditor.editing
                              ? localSeriesTitleEditor.cancel
                              : localSeriesTitleEditor.start
                          }
                        >
                          <Pencil size={17} /> {localSeriesTitleEditor.editing ? '제목 수정 취소' : '제목 수정'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                <dl className="detail-stats">
                  {seriesNovel ? (
                    <div>
                      <dt>형식</dt>
                      <dd>{localArchiveFormat}</dd>
                    </div>
                  ) : (
                    <div>
                      <dt>연재 상태</dt>
                      <dd>{controller.detail?.status ?? '정보 없음'}</dd>
                    </div>
                  )}
                  <div>
                    <dt>총 회차</dt>
                    <dd>{formatCount(contentItems.length)}화</dd>
                  </div>
                  <div>
                    <dt>작품 소스</dt>
                    <dd>{workSourceLabel}</dd>
                  </div>
                  <div>
                    <dt>라이브러리</dt>
                    <dd>{seriesNovel || controller.activeSubscription ? '추가됨' : '추가 전'}</dd>
                  </div>
                </dl>
              </section>
            ) : (
              <section className="source-hub-hero">
                <div className="source-hub-hero-copy">
                  <span className="eyebrow">외부 소스</span>
                  <h1>{activeSource?.title ?? '외부 소스'}</h1>
                  <p>
                    {isSuwayomi
                      ? 'Suwayomi에 설치된 Mihon 소스를 탐색합니다.'
                      : '목록을 확인하고 원하는 파일이나 작품만 라이브러리로 가져옵니다.'}
                  </p>
                </div>
                {controller.canPickItems && (
                  <div className="source-hub-hero-actions">
                    <button
                      type="button"
                      className="primary-btn"
                      disabled={controller.busy || controller.loading}
                      onClick={() => void controller.pickItems()}
                    >
                      {controller.busy ? <LoaderCircle size={15} className="spin" /> : <FilePlus2 size={15} />}
                      Drive에서 파일 추가
                    </button>
                  </div>
                )}
              </section>
            )}

            {activeSource?.supportsSubscriptions && !controller.detail && sourceSubscriptions.length > 0 && (
              <section className="source-hub-subscriptions" aria-labelledby="source-subscriptions-title">
                <div className="source-hub-section-heading source-hub-subscription-heading">
                  <div>
                    <h2 id="source-subscriptions-title">라이브러리에 추가한 작품</h2>
                    <span>{formatCount(sourceSubscriptions.length)}개</span>
                  </div>
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={controller.busy || controller.loading || controller.checkingSubscriptions}
                    onClick={() => void controller.checkSubscriptions()}
                  >
                    <RefreshCw size={14} className={controller.checkingSubscriptions ? 'spin' : undefined} />새 회차
                    확인
                  </button>
                </div>
                <div className="source-hub-subscription-grid">
                  {sourceSubscriptions.map((subscription) => (
                    <article key={subscription.id} className="source-hub-subscription-card">
                      <div>
                        <span className="eyebrow">{subscription.sourceLabel ?? 'Suwayomi'}</span>
                        <strong>{subscription.title}</strong>
                        <small>
                          {subscription.author ?? '작가 정보 없음'} · 회차{' '}
                          {formatCount(subscription.availableReleaseCount)}개
                        </small>
                        <small>마지막 확인 {updatedLabel(subscription.lastCheckedAt) ?? '기록 없음'}</small>
                      </div>
                      {subscription.newReleaseIds.length > 0 && (
                        <span className="source-hub-new-release-badge">
                          새 회차 {subscription.newReleaseIds.length}
                        </span>
                      )}
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={controller.blockingBusy || controller.loading}
                        onClick={() => void controller.openSubscription(subscription)}
                      >
                        <BookOpen size={14} /> 회차 보기
                      </button>
                    </article>
                  ))}
                </div>
                <p className="source-hub-subscription-note">
                  라이브러리에 추가해도 회차는 자동으로 다운로드하지 않습니다.
                </p>
              </section>
            )}

            {controller.activeSubscription && controller.activeSubscription.newReleaseIds.length > 0 && (
              <div className="source-hub-new-release-actions" role="status">
                <Bell size={18} />
                <span>
                  <strong>새 회차 {controller.activeSubscription.newReleaseIds.length}개가 있습니다.</strong>
                  원하는 회차만 선택해 기존 일괄 가져오기로 받을 수 있습니다.
                </span>
                <button
                  type="button"
                  className="primary-btn"
                  disabled={controller.busy}
                  onClick={controller.selectNewReleases}
                >
                  <ListChecks size={15} /> 새 회차 선택
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={controller.busy}
                  onClick={() => void controller.acknowledgeNewReleases()}
                >
                  확인 완료
                </button>
              </div>
            )}

            {!hasWorkHero && (controller.breadcrumbs.length > 0 || controller.stale) && (
              <div className="source-hub-location">
                {controller.breadcrumbs.length > 1 && (
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={controller.blockingBusy}
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

            {controller.browse && !controller.detail && (
              <section className="source-hub-browse-controls" aria-label="소스 탐색 방식">
                <div className="source-hub-browse-tabs">
                  <button
                    type="button"
                    className={controller.browse.activeMode === 'popular' ? 'is-active' : undefined}
                    disabled={controller.blockingBusy || controller.loading}
                    onClick={() => void controller.setBrowseMode('popular')}
                  >
                    인기
                  </button>
                  {controller.browse.availableModes.includes('latest') && (
                    <button
                      type="button"
                      className={controller.browse.activeMode === 'latest' ? 'is-active' : undefined}
                      disabled={controller.blockingBusy || controller.loading}
                      onClick={() => void controller.setBrowseMode('latest')}
                    >
                      최신
                    </button>
                  )}
                  {controller.browse.activeMode === 'search' && (
                    <span>{controller.query.trim() ? '검색 결과' : '필터 결과'}</span>
                  )}
                </div>
                {Boolean(controller.browse.filters?.length) && (
                  <details className="source-hub-filter-panel">
                    <summary>
                      <SlidersHorizontal size={15} /> 확장 필터
                    </summary>
                    <div className="source-hub-filter-grid">
                      {controller.browse.filters?.map((definition) => (
                        <FilterControl
                          key={definition.id}
                          definition={definition}
                          value={controller.filterValues[definition.id]}
                          setValue={(value) => controller.setFilterValue(definition.id, value)}
                        />
                      ))}
                    </div>
                    <div className="source-hub-filter-actions">
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={controller.blockingBusy || controller.loading}
                        onClick={() => void controller.resetFilters()}
                      >
                        <RotateCcw size={14} /> 초기화
                      </button>
                      <button
                        type="button"
                        className="primary-btn"
                        disabled={controller.blockingBusy || controller.loading}
                        onClick={() => void controller.applyFilters()}
                      >
                        적용
                      </button>
                    </div>
                  </details>
                )}
              </section>
            )}

            {updateCount > 0 && (
              <div className="source-hub-update-notice" role="status">
                <AlertTriangle size={18} />
                <span>
                  <strong>
                    {formatCount(updateCount)}개 {releaseList ? '회차' : '작품'}에 원격 업데이트가 있습니다.
                  </strong>
                  직접 업데이트하기 전까지 책장의 현재 본문은 유지됩니다.
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
                      disabled={controller.blockingBusy}
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

            <section
              className={`source-hub-items${releaseList ? ' chapter-panel source-hub-release-panel' : ''}`}
              aria-labelledby="source-items-title"
            >
              <div
                className={`source-hub-section-heading source-hub-items-heading${
                  releaseList ? ' chapter-panel-heading' : ''
                }`}
              >
                <div>
                  <h2 id="source-items-title">
                    {controller.detail ? '회차' : activeSource?.kind === 'catalog' ? '작품' : '파일'}
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
                releaseList ? (
                  <div className="source-hub-release-list" aria-label="작품 회차 목록">
                    <div className="source-hub-release-list-head" aria-hidden="true">
                      <span />
                      <span>회차</span>
                      <span>제목</span>
                      <span>업데이트</span>
                      <span>상태</span>
                      <span>작업</span>
                    </div>
                    {contentItems.map((item) => (
                      <SourceReleaseRow key={externalItemKeyId(item.key)} item={item} controller={controller} />
                    ))}
                  </div>
                ) : (
                  <div className="source-hub-card-grid" aria-label="외부 소스 작품 목록">
                    {contentItems.map((item) => (
                      <SourceItemCard
                        key={externalItemKeyId(item.key)}
                        item={item}
                        controller={controller}
                        libraryAddEnabled={Boolean(activeSource?.supportsSubscriptions)}
                      />
                    ))}
                  </div>
                )
              ) : null}

              {controller.nextCursor && (
                <button
                  className="source-hub-load-more ghost-btn"
                  type="button"
                  disabled={controller.loading || controller.blockingBusy}
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
                <span>{importProgressMessage(controller.progress, activeSource?.title ?? '외부 소스')}</span>
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
