import { BookOpen, Download, Pencil, Play, RotateCcw, Star, Trash2, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { bookFormatLabel, bookUnitLabel, isFixedDocumentFormat } from '../../domain/book-format';
import { useDismissibleLayer } from '../../shared/ui/use-dismissible-layer';
import { formatBytes, formatCount, formatProgress } from '../../utils/format';
import { BookCover } from './BookCover';
import type { LibraryScreenProps } from './library-screen-contract';
import type { LibraryBookView } from './library-screen-model';
import { LibraryReadingProgress } from './LibraryReadingProgress';

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function LibraryInspector({ book, model, actions }: LibraryScreenProps & { readonly book?: LibraryBookView }) {
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
                <strong>{formatProgress(book.bookProgress)}</strong>
              </div>
              <LibraryReadingProgress
                novel={novel}
                progress={book.bookProgress}
                positionLabel={book.readingPositionLabel}
                className="progress-track"
              />
              <small>{book.lastReadLabel}</small>
            </div>
            <button className="primary-btn wide" onClick={() => void actions.books.continueReading(novel)}>
              <Play size={17} fill="currentColor" /> {book.directActionLabel}
            </button>
            <div className="library-inspector-actions">
              <button className="ghost-btn" onClick={() => void actions.books.open(novel)}>
                <BookOpen size={16} /> {fixedDocument ? '문서 열기' : '작품 상세'}
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
            <dd>{bookFormatLabel(novel)}</dd>
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
