import {
  BookOpen,
  Check,
  Download,
  FileUp,
  FileOutput,
  FilePenLine,
  ChevronLeft,
  MoreHorizontal,
  ListTree,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Star,
  X,
} from 'lucide-react';
import type { Chapter, Novel } from '../../domain/types';
import { formatCount, formatDateTime, formatProgress } from '../../utils/format';
import type { LibraryBookView } from '../library/library-screen-model';
import type { ChapterListModel, ChapterListRowModel, ChapterReadFilter, ChapterSort } from './chapters-screen-model';
import { BookCover } from '../library/BookCover';
import { LibraryReadingProgress } from '../library/LibraryReadingProgress';

type MaybePromise = void | Promise<void>;

export interface ChaptersScreenModel {
  book: LibraryBookView;
  titleEditor: {
    editing: boolean;
    draft: string;
  };
  query: string;
  readFilter: ChapterReadFilter;
  sort: ChapterSort;
  chapterList: ChapterListModel;
  summary: {
    readChapterProgress: number;
    readLocationLabel: string;
    bookmarkCount: number;
    highlightCount: number;
    noteCount: number;
    syncLabel: string;
    firstUnreadChapter?: Chapter;
    currentReadTargetChapter?: Chapter;
    canMarkCurrentChapterRead: boolean;
    canMarkBookFinished: boolean;
    canResetBookProgress: boolean;
  };
}

export interface ChaptersScreenActions {
  navigation: {
    backToLibrary(): void;
    continueReading(): MaybePromise;
    openSettings(): void;
    openSync(): void;
    openImport(): void;
    openStructureEditor(): void;
    openMetadata(): void;
  };
  titleEditor: {
    start(): void;
    cancel(): void;
    setDraft(value: string): void;
    save(): MaybePromise;
  };
  book: {
    toggleFavorite(novel: Novel): MaybePromise;
    openFirstUnreadChapter(): MaybePromise;
    markCurrentChapterRead(): MaybePromise;
    markFinished(): MaybePromise;
    resetProgress(): MaybePromise;
    exportSource(novel: Novel): MaybePromise;
    reselectSource(novel: Novel, file: File): MaybePromise;
    reconstructSource(novel: Novel): MaybePromise;
  };
  chapterList: {
    setQuery(value: string): void;
    setReadFilter(filter: ChapterReadFilter): void;
    setSort(sort: ChapterSort): void;
    openChapter(chapter: Chapter, restore: boolean): MaybePromise;
  };
}

export interface ChaptersScreenProps {
  model: ChaptersScreenModel;
  actions: ChaptersScreenActions;
}

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function analysisStatusLabel(status: Novel['analysisStatus']): string {
  if (status === 'not_analyzed') return '꺼짐';
  if (status === 'mock_ready') return 'Mock 준비됨';
  if (status === 'queued') return '대기 중';
  if (status === 'analyzing_characters') return '인물 분석 중';
  if (status === 'labeling_segments') return '라벨링 중';
  if (status === 'building_graph') return 'Graph 구축 중';
  if (status === 'validating') return '검증 중';
  if (status === 'ready') return '라벨 준비됨';
  if (status === 'needs_review') return '검토 필요';
  if (status === 'failed') return '실패';
  if (status === 'cancelled') return '취소됨';
  return status;
}

function chapterRowAccessibleName(row: ChapterListRowModel, currentProgress: number): string {
  const state = row.isCurrent
    ? `현재 읽는 화, ${formatProgress(currentProgress)} 진행`
    : row.isRead
      ? '읽음'
      : '안 읽음';
  const annotations = row.annotationCounts
    ? [
        row.annotationCounts.bookmarks > 0 ? `북마크 ${formatCount(row.annotationCounts.bookmarks)}` : '',
        row.annotationCounts.highlights > 0 ? `하이라이트 ${formatCount(row.annotationCounts.highlights)}` : '',
        row.annotationCounts.notes > 0 ? `메모 ${formatCount(row.annotationCounts.notes)}` : '',
      ].filter(Boolean)
    : [];

  return [`${row.chapter.index}. ${row.chapter.title}`, state, row.subtitle, ...annotations].join(', ');
}

function ChaptersHeader({ model, actions }: ChaptersScreenProps) {
  const { novel } = model.book;
  return (
    <header className="sub-header chapters-header">
      <button className="icon-btn" onClick={actions.navigation.backToLibrary} title="책장으로" aria-label="책장으로">
        <ChevronLeft size={21} />
      </button>
      <BookCover novel={novel} className={classNames('book-cover thumb', model.book.coverClass)} />
      <div className="sub-title">
        {model.titleEditor.editing ? (
          <form
            id="book-title-editor"
            className="book-title-editor"
            onSubmit={(event) => {
              event.preventDefault();
              void actions.titleEditor.save();
            }}
          >
            <input
              value={model.titleEditor.draft}
              onChange={(event) => actions.titleEditor.setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  actions.titleEditor.cancel();
                }
              }}
              autoFocus
              maxLength={120}
              aria-label="책 제목"
            />
            <button className="mini-icon-btn" type="submit" title="저장" aria-label="책 제목 저장">
              <Check size={15} />
            </button>
            <button
              className="mini-icon-btn"
              type="button"
              onClick={actions.titleEditor.cancel}
              title="취소"
              aria-label="책 제목 수정 취소"
            >
              <X size={15} />
            </button>
          </form>
        ) : (
          <h1>{novel.title}</h1>
        )}
        <p>
          {model.book.readingPositionLabel} · {formatCount(novel.totalCharacters)}자 ·{' '}
          {formatProgress(model.book.chapterProgress)}
        </p>
        <div className="chapter-book-progress">
          <LibraryReadingProgress
            novel={novel}
            progress={model.book.chapterProgress}
            positionLabel={model.book.readingPositionLabel}
            className="progress-track"
          />
          <span>{model.summary.readLocationLabel}</span>
        </div>
      </div>
      <div className="header-actions">
        <label className="search-box compact">
          <Search size={16} />
          <input
            type="search"
            value={model.query}
            onChange={(event) => actions.chapterList.setQuery(event.target.value)}
            placeholder="화 검색"
            aria-label="화 검색"
          />
        </label>
        <button
          className="icon-btn chapters-metadata-action"
          onClick={actions.navigation.openMetadata}
          title="책 정보 편집"
          aria-label="책 정보 편집"
        >
          <FilePenLine size={18} />
        </button>
        {model.book.novel.format !== 'epub' && (
          <button
            className="icon-btn chapters-structure-action"
            onClick={actions.navigation.openStructureEditor}
            title="화 구조 편집"
            aria-label="화 구조 편집"
          >
            <ListTree size={18} />
          </button>
        )}
        <button
          className={classNames('icon-btn chapters-title-action', model.titleEditor.editing && 'active')}
          onClick={model.titleEditor.editing ? actions.titleEditor.cancel : actions.titleEditor.start}
          title={model.titleEditor.editing ? '제목 수정 취소' : '책 제목 수정'}
          aria-label={model.titleEditor.editing ? '책 제목 수정 취소' : '책 제목 수정'}
          aria-controls="book-title-editor"
          aria-expanded={model.titleEditor.editing}
        >
          <Pencil size={18} />
        </button>
        <button
          className={classNames('icon-btn chapters-favorite-action', novel.favorite && 'active')}
          onClick={() => void actions.book.toggleFavorite(novel)}
          title={novel.favorite ? '즐겨찾기 해제' : '즐겨찾기'}
          aria-label={`${novel.title} ${novel.favorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}`}
          aria-pressed={novel.favorite}
        >
          <Star size={18} fill={novel.favorite ? 'currentColor' : 'none'} />
        </button>
        <button className="primary-btn" onClick={() => void actions.navigation.continueReading()}>
          <Play size={18} /> 이어 읽기
        </button>
      </div>
    </header>
  );
}

function ChapterList({ model, actions }: ChaptersScreenProps) {
  return (
    <section className="chapter-list" aria-label="화 목록">
      <div className="chapter-tools">
        <div className="segmented" role="group" aria-label="읽은 상태 필터">
          <button
            className={model.readFilter === 'all' ? 'active' : ''}
            onClick={() => actions.chapterList.setReadFilter('all')}
            aria-pressed={model.readFilter === 'all'}
          >
            전체
          </button>
          <button
            className={model.readFilter === 'unread' ? 'active' : ''}
            onClick={() => actions.chapterList.setReadFilter('unread')}
            aria-pressed={model.readFilter === 'unread'}
          >
            안 읽음
          </button>
          <button
            className={model.readFilter === 'read' ? 'active' : ''}
            onClick={() => actions.chapterList.setReadFilter('read')}
            aria-pressed={model.readFilter === 'read'}
          >
            읽음
          </button>
        </div>
        <div className="segmented" role="group" aria-label="화 정렬">
          <button
            className={model.sort === 'asc' ? 'active' : ''}
            onClick={() => actions.chapterList.setSort('asc')}
            aria-pressed={model.sort === 'asc'}
          >
            처음화
          </button>
          <button
            className={model.sort === 'desc' ? 'active' : ''}
            onClick={() => actions.chapterList.setSort('desc')}
            aria-pressed={model.sort === 'desc'}
          >
            최신화
          </button>
        </div>
        <span>
          {formatCount(model.chapterList.rows.length)} / {formatCount(model.chapterList.totalCount)}화
        </span>
      </div>
      {model.chapterList.rows.length === 0 ? (
        <div className="empty-panel chapter-empty">
          <strong>검색 결과가 없습니다.</strong>
          <span>다른 화 제목으로 검색해보세요.</span>
          <button
            className="ghost-btn"
            onClick={() => {
              actions.chapterList.setQuery('');
              actions.chapterList.setReadFilter('all');
            }}
            disabled={!model.query.trim() && model.readFilter === 'all'}
          >
            검색/필터 초기화
          </button>
        </div>
      ) : (
        model.chapterList.rows.map((row) => (
          <button
            key={row.chapter.id}
            className={classNames('chapter-row', row.isCurrent && 'is-current', row.isRead && 'is-read')}
            onClick={() => void actions.chapterList.openChapter(row.chapter, row.isCurrent)}
            aria-current={row.isCurrent ? 'location' : undefined}
            aria-label={chapterRowAccessibleName(row, model.summary.readChapterProgress)}
          >
            <span className="chapter-number">{row.chapter.index.toString().padStart(2, '0')}</span>
            <span className="chapter-main">
              <strong>{row.chapter.title}</strong>
              <small>{row.subtitle}</small>
              {row.annotationCounts && (
                <span className="chapter-annotation-chips">
                  {row.annotationCounts.bookmarks > 0 && <em>북마크 {formatCount(row.annotationCounts.bookmarks)}</em>}
                  {row.annotationCounts.highlights > 0 && (
                    <em>하이라이트 {formatCount(row.annotationCounts.highlights)}</em>
                  )}
                  {row.annotationCounts.notes > 0 && <em>메모 {formatCount(row.annotationCounts.notes)}</em>}
                </span>
              )}
            </span>
            {row.isCurrent ? (
              <span className="status-pill">{formatProgress(model.summary.readChapterProgress)}</span>
            ) : row.isRead ? (
              <span className="status-pill muted">읽음</span>
            ) : (
              <MoreHorizontal size={18} />
            )}
          </button>
        ))
      )}
    </section>
  );
}

function ReadingSummaryContent({
  model,
  actions,
  showHeading = true,
}: ChaptersScreenProps & { showHeading?: boolean }) {
  const { novel } = model.book;
  const { summary } = model;
  return (
    <>
      {showHeading && <h2>독서 정보</h2>}
      <dl>
        <div>
          <dt>진행률</dt>
          <dd>{formatProgress(novel.lastReadProgress)}</dd>
        </div>
        <div>
          <dt>상태</dt>
          <dd>{model.book.readingStatusLabel}</dd>
        </div>
        <div>
          <dt>위치</dt>
          <dd title={summary.readLocationLabel}>{summary.readLocationLabel}</dd>
        </div>
        <div>
          <dt>북마크</dt>
          <dd>{summary.bookmarkCount}개</dd>
        </div>
        <div>
          <dt>하이라이트</dt>
          <dd>{summary.highlightCount}개</dd>
        </div>
        <div>
          <dt>메모</dt>
          <dd>{summary.noteCount}개</dd>
        </div>
        <div>
          <dt>문단</dt>
          <dd>{formatCount(novel.totalParagraphs)}개</dd>
        </div>
        <div>
          <dt>누적 독서</dt>
          <dd>{model.book.readingTimeLabel}</dd>
        </div>
        <div>
          <dt>최근 읽음</dt>
          <dd>{model.book.lastReadLabel}</dd>
        </div>
        <div>
          <dt>원본</dt>
          <dd title={novel.sourceFileName}>{novel.sourceFileName}</dd>
        </div>
        <div>
          <dt>원본 보관</dt>
          <dd>
            {novel.sourceAssetId
              ? `${novel.sourceProvenance === 'original' ? '원본' : '재구성'} · ${formatCount(novel.sourceByteLength ?? 0)}B`
              : '보관된 원본 없음'}
          </dd>
        </div>
        <div>
          <dt>원본 hash</dt>
          <dd title={novel.sourceContentHash}>{novel.sourceContentHash?.slice(0, 12) ?? '-'}</dd>
        </div>
        <div>
          <dt>인코딩</dt>
          <dd>{novel.sourceEncoding?.toUpperCase() ?? '-'}</dd>
        </div>
        <div>
          <dt>수정일</dt>
          <dd>{formatDateTime(novel.updatedAt)}</dd>
        </div>
        <div>
          <dt>동기화</dt>
          <dd>{summary.syncLabel}</dd>
        </div>
        <div>
          <dt>AI 애드온</dt>
          <dd>{analysisStatusLabel(novel.analysisStatus)}</dd>
        </div>
      </dl>
      <div className="reader-summary-actions">
        <button className="ghost-btn wide" onClick={actions.navigation.openMetadata}>
          <FilePenLine size={18} /> 작품 정보 편집
        </button>
        {novel.format !== 'epub' && (
          <button className="ghost-btn wide" onClick={actions.navigation.openStructureEditor}>
            <ListTree size={18} /> 화 구조 편집
          </button>
        )}
        <button
          className={classNames('ghost-btn wide', novel.favorite && 'active')}
          onClick={() => void actions.book.toggleFavorite(novel)}
          aria-pressed={novel.favorite}
        >
          <Star size={18} fill={novel.favorite ? 'currentColor' : 'none'} />
          {novel.favorite ? '즐겨찾기 해제' : '즐겨찾기'}
        </button>
        <button
          className="ghost-btn wide"
          onClick={() => void actions.book.exportSource(novel)}
          disabled={!novel.sourceAssetId}
        >
          <Download size={18} /> 원본 다운로드
        </button>
        <label className="ghost-btn wide source-reselect-button">
          <FileUp size={18} /> 원본 다시 선택
          <input
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void actions.book.reselectSource(novel, file);
            }}
          />
        </label>
        {!novel.sourceAssetId && (
          <button className="ghost-btn wide" onClick={() => void actions.book.reconstructSource(novel)}>
            <FileOutput size={18} /> 재구성본 만들기
          </button>
        )}
        <button className="ghost-btn wide" onClick={actions.navigation.openSettings}>
          <SlidersHorizontal size={18} /> 읽기 설정
        </button>
        <button className="ghost-btn wide" onClick={actions.navigation.openSync}>
          <RefreshCw size={18} /> 동기화 상세
        </button>
        <button
          className="ghost-btn wide"
          onClick={() => void actions.book.openFirstUnreadChapter()}
          disabled={!summary.firstUnreadChapter}
          title={
            summary.firstUnreadChapter
              ? `${summary.firstUnreadChapter.index}. ${summary.firstUnreadChapter.title}`
              : undefined
          }
        >
          <BookOpen size={18} /> 첫 미독 화
        </button>
        <button
          className="ghost-btn wide"
          onClick={() => void actions.book.markCurrentChapterRead()}
          disabled={!summary.canMarkCurrentChapterRead}
          title={
            summary.currentReadTargetChapter
              ? `${summary.currentReadTargetChapter.index}. ${summary.currentReadTargetChapter.title}`
              : undefined
          }
        >
          <Check size={18} /> 현재 화 읽음
        </button>
        <button
          className="ghost-btn wide"
          onClick={() => void actions.book.markFinished()}
          disabled={!summary.canMarkBookFinished}
        >
          <Check size={18} /> 완독 처리
        </button>
        <button
          className="ghost-btn wide"
          onClick={() => void actions.book.resetProgress()}
          disabled={!summary.canResetBookProgress}
        >
          <RotateCcw size={18} /> 읽은 위치 초기화
        </button>
        <button className="ghost-btn wide" onClick={actions.navigation.openImport}>
          <Plus size={18} /> 다른 책 추가
        </button>
      </div>
    </>
  );
}

function ReadingSummary({ model, actions }: ChaptersScreenProps) {
  return (
    <aside className="reader-summary reader-summary-desktop">
      <ReadingSummaryContent model={model} actions={actions} />
    </aside>
  );
}

function MobileReadingSummary({ model, actions }: ChaptersScreenProps) {
  return (
    <details className="reader-summary reader-summary-mobile">
      <summary>
        <span>
          <SlidersHorizontal size={18} /> 책 정보 및 작업
        </span>
        <strong>{formatProgress(model.book.chapterProgress)}</strong>
      </summary>
      <div className="reader-summary-mobile-body">
        <ReadingSummaryContent model={model} actions={actions} showHeading={false} />
      </div>
    </details>
  );
}

export function ChaptersScreen({ model, actions }: ChaptersScreenProps) {
  return (
    <main className="chapters-screen">
      <ChaptersHeader model={model} actions={actions} />
      <MobileReadingSummary model={model} actions={actions} />
      <div className="chapter-layout">
        <ChapterList model={model} actions={actions} />
        <ReadingSummary model={model} actions={actions} />
      </div>
    </main>
  );
}
