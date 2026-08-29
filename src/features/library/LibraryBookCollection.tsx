import { BookOpen, Check, Pencil, Play, RotateCcw, Star, Trash2 } from 'lucide-react';
import { bookFormatLabel, isFixedDocumentFormat } from '../../domain/book-format';
import { formatCount, formatProgress } from '../../utils/format';
import type { LibraryBookView } from './library-screen-model';
import type { LibraryExternalWorkView, LibraryScreenProps } from './library-screen-contract';
import { LibraryReadingProgress } from './LibraryReadingProgress';
import { BookCover } from './BookCover';

interface LibraryBookItemProps extends LibraryScreenProps {
  readonly book: LibraryBookView;
}

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function useItemState({ book, model }: LibraryBookItemProps) {
  const selected = model.management.selectionMode && model.management.selectedBookIds.has(book.novel.id);
  const focused = !model.management.selectionMode && model.presentation.focusedBookId === book.novel.id;
  return {
    trashed: Boolean(book.novel.deletedAt),
    selected,
    focused,
  };
}

function activateBook({ book, model, actions }: LibraryBookItemProps): void {
  if (model.management.selectionMode) {
    actions.books.toggleSelected(book.novel);
    return;
  }
  if (book.novel.deletedAt) {
    if (model.presentation.layoutMode !== 'mobile') actions.presentation.focusBook(book.novel);
    return;
  }
  actions.presentation.focusBook(book.novel);
  void actions.books.open(book.novel);
}

function BookItemActions({ book, model, actions }: LibraryBookItemProps) {
  if (model.management.selectionMode) return null;
  const { novel } = book;
  const trashed = Boolean(novel.deletedAt);

  if (trashed) {
    return (
      <div className="card-actions">
        <button
          type="button"
          className="mini-icon-btn"
          title="복원"
          aria-label={`${novel.title} 복원`}
          onClick={() => void actions.books.restore(novel)}
        >
          <RotateCcw size={15} />
        </button>
        <button
          type="button"
          className="mini-icon-btn danger"
          title="영구 삭제"
          aria-label={`${novel.title} 영구 삭제`}
          onClick={() => void actions.books.purge(novel)}
        >
          <Trash2 size={15} />
        </button>
      </div>
    );
  }

  return (
    <div className="card-actions">
      <button
        type="button"
        className="mini-icon-btn book-edit-action"
        title="작품 정보 편집"
        aria-label={`${novel.title} 정보 편집`}
        onClick={() => actions.books.editMetadata(novel)}
      >
        <Pencil size={15} />
      </button>
      <button
        type="button"
        className={classNames('mini-icon-btn book-favorite-action', novel.favorite && 'active')}
        title={novel.favorite ? '즐겨찾기 해제' : '즐겨찾기'}
        aria-label={`${novel.title} ${novel.favorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}`}
        aria-pressed={novel.favorite}
        onClick={() => void actions.books.toggleFavorite(novel)}
      >
        <Star size={15} fill={novel.favorite ? 'currentColor' : 'none'} />
      </button>
      <button
        type="button"
        className="book-direct-action book-continue-action"
        title={book.directActionLabel}
        aria-label={`${novel.title} ${book.directActionLabel}`}
        onClick={() => void actions.books.continueReading(novel)}
      >
        <Play size={13} fill="currentColor" />
        <span>{book.directActionLabel}</span>
      </button>
      <button
        type="button"
        className="mini-icon-btn book-remove-action"
        title="휴지통으로 이동"
        aria-label={`${novel.title} 휴지통으로 이동`}
        onClick={() => void actions.books.remove(novel)}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function SelectionMark({ selected }: { readonly selected: boolean }) {
  return (
    <span className="book-selection-mark" aria-hidden="true">
      {selected && <Check size={15} />}
    </span>
  );
}

function ExternalWorkCover({ work, thumbnail }: { work: LibraryExternalWorkView; thumbnail: boolean }) {
  return (
    <div className={classNames('book-cover', !thumbnail && 'thumb', thumbnail && 'has-remote-cover')}>
      {work.thumbnailUrl ? (
        <img src={work.thumbnailUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
      ) : (
        <span className="external-work-cover-fallback" aria-hidden="true">
          <BookOpen size={32} />
        </span>
      )}
    </div>
  );
}

function ExternalWorkActions({
  work,
  actions,
}: Pick<LibraryScreenProps, 'actions'> & { work: LibraryExternalWorkView }) {
  return (
    <div className="card-actions">
      <button
        type="button"
        className="mini-icon-btn book-remove-action"
        title="라이브러리에서 제거"
        aria-label={`${work.title} 라이브러리에서 제거`}
        onClick={() => void actions.books.removeExternal(work.id)}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function ExternalWorkCard({ work, actions }: Pick<LibraryScreenProps, 'actions'> & { work: LibraryExternalWorkView }) {
  return (
    <article className="book-card external-work-card" role="listitem">
      <button
        type="button"
        className="book-card-open"
        aria-label={`${work.title} 원격 회차 열기`}
        onClick={() => void actions.books.openExternal(work.id)}
      />
      <div className="book-cover-wrap">
        <ExternalWorkCover work={work} thumbnail />
      </div>
      <div className="book-info">
        <div className="book-title-line">
          <h3>{work.title}</h3>
        </div>
        <p>{[work.author, work.sourceLabel].filter(Boolean).join(' · ')}</p>
        <div className="card-row">
          <strong>{formatCount(work.availableReleaseCount)}화</strong>
          <span>{work.newReleaseCount > 0 ? `새 회차 ${work.newReleaseCount}개` : '새 회차 확인됨'}</span>
          <ExternalWorkActions work={work} actions={actions} />
        </div>
      </div>
    </article>
  );
}

function ExternalWorkListRow({
  work,
  actions,
}: Pick<LibraryScreenProps, 'actions'> & { work: LibraryExternalWorkView }) {
  return (
    <article className="book-list-row external-work-list-row" role="listitem">
      <button
        type="button"
        className="book-card-open"
        aria-label={`${work.title} 원격 회차 열기`}
        onClick={() => void actions.books.openExternal(work.id)}
      />
      <ExternalWorkCover work={work} thumbnail={false} />
      <div className="book-list-main">
        <div className="book-list-title">
          <h3>{work.title}</h3>
        </div>
        <p>
          {[work.author, work.sourceLabel, `원격 회차 ${formatCount(work.availableReleaseCount)}개`]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      <div className="book-list-progress">
        <strong>{work.newReleaseCount > 0 ? `새 회차 ${work.newReleaseCount}` : '최신'}</strong>
        <span>Suwayomi 연결 작품</span>
      </div>
      <ExternalWorkActions work={work} actions={actions} />
    </article>
  );
}

function LibraryBookCard(props: LibraryBookItemProps) {
  const { book, model } = props;
  const { trashed, selected, focused } = useItemState(props);

  return (
    <article
      className={classNames('book-card', selected && 'is-selected', focused && 'is-focused')}
      role="listitem"
      data-focused={focused || undefined}
      data-selected={selected || undefined}
    >
      <button
        type="button"
        className="book-card-open"
        onClick={() => activateBook(props)}
        aria-pressed={model.management.selectionMode ? selected : undefined}
        aria-label={
          model.management.selectionMode
            ? `${book.novel.title} ${selected ? '선택 해제' : '선택'}`
            : `${book.novel.title} ${isFixedDocumentFormat(book.novel.format) ? '문서 열기' : '작품 상세 열기'}`
        }
      />
      <div className="book-cover-wrap">
        <BookCover novel={book.novel} className={classNames('book-cover', book.coverClass)}>
          {model.management.selectionMode && <SelectionMark selected={selected} />}
          {!model.management.selectionMode && (
            <span className="book-format-overlay">{bookFormatLabel(book.novel)}</span>
          )}
        </BookCover>
      </div>
      <div className="book-info">
        <div className="book-title-line">
          <h3>{book.novel.title}</h3>
          {book.novel.favorite && <Star className="book-favorite-mark" size={14} fill="currentColor" />}
        </div>
        <p>{[book.novel.author, book.readingPositionLabel].filter(Boolean).join(' · ')}</p>
        {!trashed && (
          <LibraryReadingProgress
            novel={book.novel}
            progress={book.bookProgress}
            positionLabel={book.readingPositionLabel}
            className="card-progress"
          />
        )}
        <div className="card-row">
          <strong>{trashed ? '휴지통' : formatProgress(book.bookProgress)}</strong>
          <span>{book.lastReadLabel}</span>
          <BookItemActions {...props} />
        </div>
      </div>
    </article>
  );
}

function LibraryBookListRow(props: LibraryBookItemProps) {
  const { book, model } = props;
  const { trashed, selected, focused } = useItemState(props);

  return (
    <article
      className={classNames('book-list-row', selected && 'is-selected', focused && 'is-focused')}
      role="listitem"
      data-focused={focused || undefined}
      data-selected={selected || undefined}
    >
      <button
        type="button"
        className="book-card-open"
        onClick={() => activateBook(props)}
        aria-pressed={model.management.selectionMode ? selected : undefined}
        aria-label={
          model.management.selectionMode
            ? `${book.novel.title} ${selected ? '선택 해제' : '선택'}`
            : `${book.novel.title} ${isFixedDocumentFormat(book.novel.format) ? '문서 열기' : '작품 상세 열기'}`
        }
      />
      <BookCover novel={book.novel} className={classNames('book-cover thumb', book.coverClass)}>
        {model.management.selectionMode && <SelectionMark selected={selected} />}
        {!model.management.selectionMode && <span className="book-format-overlay">{bookFormatLabel(book.novel)}</span>}
      </BookCover>
      <div className="book-list-main">
        <div className="book-list-title">
          <h3>{book.novel.title}</h3>
          {book.novel.favorite && <Star size={14} fill="currentColor" />}
        </div>
        <p>{[book.novel.author, book.readingPositionLabel, book.readingTimeLabel].filter(Boolean).join(' · ')}</p>
        {!trashed && (
          <LibraryReadingProgress
            novel={book.novel}
            progress={book.bookProgress}
            positionLabel={book.readingPositionLabel}
            className="card-progress"
          />
        )}
      </div>
      <div className="book-list-progress">
        <strong>{trashed ? '휴지통' : formatProgress(book.bookProgress)}</strong>
        <span>{book.lastReadLabel}</span>
      </div>
      <BookItemActions {...props} />
    </article>
  );
}

export function LibraryBookCollection(props: LibraryScreenProps) {
  const collectionClass = props.model.viewMode === 'grid' ? 'books-grid' : 'books-list';
  const externalWorks = props.model.management.selectionMode ? [] : (props.model.externalSources.libraryWorks ?? []);
  return (
    <>
      {props.model.management.selectionMode && (
        <p className="sr-only" role="status" aria-live="polite">
          {props.model.management.selectedBookIds.size}권 선택됨
        </p>
      )}
      <div className={collectionClass} role="list" aria-label="작품 목록">
        {props.model.viewMode === 'list' && (
          <div className="book-list-head" aria-hidden="true">
            <span>작품</span>
            <span>전체 진행률</span>
            <span>작업</span>
          </div>
        )}
        {externalWorks.map((work) =>
          props.model.viewMode === 'grid' ? (
            <ExternalWorkCard key={work.id} work={work} actions={props.actions} />
          ) : (
            <ExternalWorkListRow key={work.id} work={work} actions={props.actions} />
          ),
        )}
        {props.model.collection.visibleBooks.map((book) =>
          props.model.viewMode === 'grid' ? (
            <LibraryBookCard key={book.novel.id} book={book} {...props} />
          ) : (
            <LibraryBookListRow key={book.novel.id} book={book} {...props} />
          ),
        )}
      </div>
    </>
  );
}
