import { Clock3, Play, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatCount, formatProgress } from '../../utils/format';
import { initialChapterPage, paginateChapterRows, type ChapterListRowModel } from './chapters-screen-model';
import type { ChaptersScreenProps } from './chapters-screen-contract';
import { ChapterPagination } from './ChapterPagination';

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function annotationLabel(row: ChapterListRowModel): string {
  if (!row.annotationCounts) return '';
  return [
    row.annotationCounts.bookmarks > 0 ? `북마크 ${formatCount(row.annotationCounts.bookmarks)}` : '',
    row.annotationCounts.highlights > 0 ? `하이라이트 ${formatCount(row.annotationCounts.highlights)}` : '',
    row.annotationCounts.notes > 0 ? `메모 ${formatCount(row.annotationCounts.notes)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function chapterRowAccessibleName(row: ChapterListRowModel, currentProgress: number): string {
  const state = row.isCurrent
    ? `현재 읽는 화, ${formatProgress(currentProgress)} 진행`
    : row.isRead
      ? '읽음'
      : '안 읽음';
  return [
    `${row.chapter.index}화, ${row.chapter.title}`,
    state,
    row.characterCountLabel,
    row.paragraphCountLabel,
    `TTS ${row.ttsDuration.label}`,
    annotationLabel(row),
  ]
    .filter(Boolean)
    .join(', ');
}

function ChapterRow({ row, model, actions }: { row: ChapterListRowModel } & ChaptersScreenProps) {
  const annotations = annotationLabel(row);
  return (
    <button
      type="button"
      className={classNames(
        'chapter-row',
        row.isCurrent && 'is-current',
        row.isRead && 'is-read',
        !row.isRead && 'is-unread',
      )}
      onClick={() => void actions.chapterList.openChapter(row.chapter, row.isCurrent)}
      aria-current={row.isCurrent ? 'location' : undefined}
      aria-label={chapterRowAccessibleName(row, model.summary.readChapterProgress)}
    >
      <span className="chapter-marker" aria-hidden="true">
        {row.isCurrent ? <Play size={13} fill="currentColor" /> : <i />}
      </span>
      <span className="chapter-index">{row.chapter.index}화</span>
      <span className="chapter-title-cell">
        <strong>{row.chapter.title}</strong>
        <small>
          {row.paragraphCountLabel}
          {annotations && ` · ${annotations}`}
        </small>
      </span>
      <span className="chapter-character-count">{row.characterCountLabel}</span>
      <span className="chapter-tts-duration">
        <Clock3 size={13} /> {row.ttsDuration.label}
      </span>
      <em>{row.isCurrent ? '읽는 중' : row.isRead ? '읽음' : '안 읽음'}</em>
      <span className="chapter-row-action" aria-hidden="true">
        {row.isCurrent ? (
          <>
            <Play size={13} fill="currentColor" />
            <span>이어 읽기</span>
          </>
        ) : (
          '›'
        )}
      </span>
    </button>
  );
}

export function ChapterPanel({ model, actions }: ChaptersScreenProps) {
  const rows = model.chapterList.rows;
  const [requestedPage, setRequestedPage] = useState(() => initialChapterPage(rows));
  const previousBookId = useRef(model.book.novel.id);
  const previousControls = useRef(`${model.query}\0${model.readFilter}\0${model.sort}`);
  const previousRowsLength = useRef(rows.length);
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pageModel = paginateChapterRows(rows, requestedPage);

  useEffect(() => {
    if (previousBookId.current !== model.book.novel.id) {
      previousBookId.current = model.book.novel.id;
      setRequestedPage(initialChapterPage(rows));
    } else if (previousRowsLength.current === 0 && rows.length > 0) {
      setRequestedPage(initialChapterPage(rows));
    }
    previousRowsLength.current = rows.length;
  }, [model.book.novel.id, rows]);

  useEffect(() => {
    const controls = `${model.query}\0${model.readFilter}\0${model.sort}`;
    if (previousControls.current !== controls) {
      previousControls.current = controls;
      setRequestedPage(1);
    }
  }, [model.query, model.readFilter, model.sort]);

  useEffect(() => {
    if (requestedPage !== pageModel.page) setRequestedPage(pageModel.page);
  }, [pageModel.page, requestedPage]);

  const moveToPage = (page: number) => {
    setRequestedPage(page);
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
      const panel = panelRef.current;
      if (panel && panel.getBoundingClientRect().top < 0) panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  };

  const resetPageAnd = (action: () => void) => {
    setRequestedPage(1);
    action();
  };

  return (
    <section ref={panelRef} className="chapter-panel" aria-labelledby="chapter-panel-title">
      <header className="chapter-panel-heading">
        <div>
          <h2 id="chapter-panel-title" ref={headingRef} tabIndex={-1}>
            회차
          </h2>
          <span>{formatCount(rows.length)}</span>
        </div>
      </header>
      <div className="chapter-toolbar">
        <label className="chapter-search">
          <Search size={16} />
          <input
            type="search"
            value={model.query}
            onChange={(event) => resetPageAnd(() => actions.chapterList.setQuery(event.target.value))}
            placeholder="회차 또는 제목 검색"
            aria-label="화 검색"
          />
        </label>
        <div className="chapter-filter" role="group" aria-label="읽은 상태 필터">
          {(['all', 'unread', 'read'] as const).map((filter) => (
            <button
              type="button"
              key={filter}
              className={model.readFilter === filter ? 'is-selected' : ''}
              onClick={() => resetPageAnd(() => actions.chapterList.setReadFilter(filter))}
              aria-pressed={model.readFilter === filter}
            >
              {filter === 'all' ? '전체' : filter === 'unread' ? '안 읽음' : '읽음'}
            </button>
          ))}
        </div>
        <label className="chapter-order">
          <span>정렬</span>
          <select
            value={model.sort}
            onChange={(event) => resetPageAnd(() => actions.chapterList.setSort(event.target.value as 'asc' | 'desc'))}
            aria-label="화 정렬"
          >
            <option value="asc">처음 화부터</option>
            <option value="desc">최신 화부터</option>
          </select>
        </label>
      </div>
      {rows.length === 0 ? (
        <div className="empty-panel chapter-empty">
          <strong>검색 결과가 없습니다.</strong>
          <button
            type="button"
            className="ghost-btn"
            onClick={() =>
              resetPageAnd(() => {
                actions.chapterList.setQuery('');
                actions.chapterList.setReadFilter('all');
              })
            }
            disabled={!model.query.trim() && model.readFilter === 'all'}
          >
            검색/필터 초기화
          </button>
        </div>
      ) : (
        <div className="chapter-list" aria-label={`${model.book.novel.title} 회차 목록`}>
          <div className="chapter-list-head" aria-hidden="true">
            <span />
            <span>회차</span>
            <span>제목</span>
            <span>글자 수</span>
            <span>TTS 예상</span>
            <span>상태</span>
            <span />
          </div>
          {pageModel.rows.map((row) => (
            <ChapterRow key={row.chapter.id} row={row} model={model} actions={actions} />
          ))}
        </div>
      )}
      <footer className="chapter-panel-footer">
        <span>
          {pageModel.rangeStart}–{pageModel.rangeEnd} / {formatCount(pageModel.resultCount)}화
        </span>
        <ChapterPagination page={pageModel.page} pageCount={pageModel.pageCount} onPage={moveToPage} />
        <span>페이지당 {pageModel.pageSize}화</span>
      </footer>
    </section>
  );
}
