import { AlertTriangle, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { externalItemKeyId } from '../../external-sources/contracts';
import { formatCount } from '../../utils/format';
import { ChapterPagination } from '../chapters/ChapterPagination';
import {
  filterAndSortReleases,
  paginateReleases,
  SOURCE_RELEASE_PAGE_SIZE,
  type ReleaseReadFilter,
  type ReleaseSort,
} from './source-release-list-model';
import type { ExternalSourceController, ExternalSourceItemView } from './useExternalSourceController';

export function SourceReleasePanel({
  controller,
  items,
  renderItem,
}: {
  controller: ExternalSourceController;
  items: readonly ExternalSourceItemView[];
  renderItem(item: ExternalSourceItemView): ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [readFilter, setReadFilter] = useState<ReleaseReadFilter>('all');
  const [sort, setSort] = useState<ReleaseSort>('asc');
  const sorted = useMemo(() => filterAndSortReleases(items, query, readFilter, sort), [items, query, readFilter, sort]);
  const [requestedPage, setRequestedPage] = useState(1);
  const page = paginateReleases(sorted, requestedPage);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const cursor = controller.nextCursor;
  const partial = Boolean(cursor || controller.listError || controller.stale);

  useEffect(() => {
    if (requestedPage !== page.page) setRequestedPage(page.page);
  }, [requestedPage, page.page]);

  const selectable = page.items.filter(
    (item) =>
      item.importability !== 'unsupported' &&
      (item.importState === 'available' || item.importState === 'update_available'),
  );
  const selectedHere = selectable.filter((item) => item.selected).length;
  const selectedTotal = items.filter(
    (item) => item.selected && (item.importState === 'available' || item.importState === 'update_available'),
  ).length;
  const selectionRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectionRef.current) selectionRef.current.indeterminate = selectedHere > 0 && selectedHere < selectable.length;
  }, [selectedHere, selectable.length]);

  const moveToPage = (next: number) => {
    setRequestedPage(next);
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
      if (panelRef.current && panelRef.current.getBoundingClientRect().top < 0)
        panelRef.current.scrollIntoView({ block: 'start' });
    });
  };

  return (
    <section
      ref={panelRef}
      className="source-hub-items chapter-panel source-hub-release-panel"
      aria-labelledby="source-items-title"
    >
      <div className="source-hub-section-heading source-hub-items-heading chapter-panel-heading">
        <div>
          <h2 id="source-items-title" ref={headingRef} tabIndex={-1}>
            회차
          </h2>
          <span>
            {formatCount(items.length)}화{partial ? ' 불러옴' : ''}
          </span>
          {controller.catalogLoading && <span role="status">목차 확인 중</span>}
          {controller.catalogUpdateAvailable && (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                controller.applyCatalogUpdate?.();
                setRequestedPage(1);
              }}
            >
              새 목차 적용
            </button>
          )}
        </div>
        <label>
          <input
            ref={selectionRef}
            type="checkbox"
            checked={selectable.length > 0 && selectedHere === selectable.length}
            disabled={!selectable.length || controller.busy}
            onChange={(event) =>
              controller.selectAllSupported(
                event.target.checked,
                selectable.map((item) => externalItemKeyId(item.key)),
              )
            }
          />
          이 페이지 선택
        </label>
      </div>
      <div className="chapter-toolbar">
        <label className="chapter-search">
          <Search size={16} />
          <input
            type="search"
            value={query}
            placeholder="회차 또는 제목 검색"
            aria-label="회차 검색"
            onChange={(event) => {
              setQuery(event.target.value);
              setRequestedPage(1);
            }}
          />
        </label>
        <div className="chapter-filter" role="group" aria-label="읽음 상태 필터">
          {(['all', 'unread', 'read'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={readFilter === value ? 'is-selected' : ''}
              aria-pressed={readFilter === value}
              onClick={() => {
                setReadFilter(value);
                setRequestedPage(1);
              }}
            >
              {value === 'all' ? '전체' : value === 'unread' ? '안 읽음' : '읽음'}
            </button>
          ))}
        </div>
        <label className="chapter-order">
          <span>정렬</span>
          <select
            aria-label="회차 정렬"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as ReleaseSort);
              setRequestedPage(1);
            }}
          >
            <option value="asc">처음 화부터</option>
            <option value="desc">최신 화부터</option>
          </select>
        </label>
      </div>
      {partial && (
        <div className="source-release-catalog-status" role="status">
          <span>
            {controller.loading || controller.catalogLoading
              ? '나머지 목차를 백그라운드에서 불러오는 중입니다. 회차를 선택하거나 읽을 수 있습니다.'
              : '목차 일부만 불러왔습니다.'}{' '}
            검색·정렬은 불러온 {formatCount(items.length)}화에 적용됩니다.
          </span>
          {cursor && !controller.loading && !controller.catalogLoading && !controller.listError && (
            <button
              className="ghost-btn"
              type="button"
              disabled={controller.blockingBusy || controller.importBusy}
              onClick={() => {
                void controller.loadMore();
              }}
            >
              목차 더 불러오기
            </button>
          )}
        </div>
      )}
      {controller.listError && (
        <div className="source-hub-list-error" role="alert">
          <AlertTriangle size={18} />
          <div>
            <strong>목록을 불러오지 못했습니다.</strong>
            <p>{controller.listError.message}</p>
            <button
              className="ghost-btn"
              type="button"
              disabled={controller.loading || controller.blockingBusy}
              onClick={() => {
                void controller.listError?.retry();
              }}
            >
              <RefreshCw size={15} /> 목록 다시 불러오기
            </button>
          </div>
        </div>
      )}
      {controller.loading && (
        <div className="source-hub-loading-status" role="status">
          <LoaderCircle size={16} className="spin" />
          전체 목차를 준비하고 있습니다. 처음 화부터 한 번에 표시합니다.
        </div>
      )}
      {sorted.length ? (
        <div className="source-hub-release-list" aria-label="작품 회차 목록">
          <div className="source-hub-release-list-head" aria-hidden="true">
            <span />
            <span>회차</span>
            <span>제목</span>
            <span>업데이트</span>
            <span>상태</span>
            <span>작업</span>
          </div>
          {page.items.map(renderItem)}
        </div>
      ) : !controller.loading ? (
        <div className="empty-panel chapter-empty">
          <strong>{query || readFilter !== 'all' ? '검색 결과가 없습니다.' : '표시할 회차가 없습니다.'}</strong>
          {(query || readFilter !== 'all') && (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setQuery('');
                setReadFilter('all');
                setRequestedPage(1);
              }}
            >
              검색·필터 초기화
            </button>
          )}
        </div>
      ) : null}
      <footer className="chapter-panel-footer">
        <span>
          {page.rangeStart}–{page.rangeEnd} / {formatCount(sorted.length)}화
        </span>
        <ChapterPagination page={page.page} pageCount={page.pageCount} onPage={moveToPage} />
        <span>페이지당 {SOURCE_RELEASE_PAGE_SIZE}화</span>
      </footer>
      {selectedTotal > 0 && (
        <div className="source-release-selection-summary">
          <span>
            전체 {formatCount(selectedTotal)}화 선택 · 이 페이지 {selectedHere}화
          </span>
          <button
            type="button"
            className="ghost-btn"
            disabled={controller.busy}
            onClick={() => controller.selectAllSupported(false)}
          >
            전체 선택 해제
          </button>
        </div>
      )}
    </section>
  );
}
