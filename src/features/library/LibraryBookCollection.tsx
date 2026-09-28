import { externalSelectionId } from './library-batch';
import { LibraryCountLabel } from './LibraryCountLabel';
import { isCoverView } from '../../components/work-view';
import { Check, Pencil, Play, RotateCcw, Star, Trash2 } from 'lucide-react';
import { bookFormatLabel, isFixedDocumentFormat } from '../../domain/book-format';
import { formatProgress } from '../../utils/format';
import type { LibraryBookView } from './library-screen-model';
import type { LibraryScreenProps } from './library-screen-contract';
import { ExternalWorkCard, ExternalWorkListRow } from './LibraryExternalWorkItems';
import { LibraryReadingProgress } from './LibraryReadingProgress';
import { BookCover } from './BookCover';
import { VirtualizedLibraryCollection } from './VirtualizedLibraryCollection';
import { importTaskIsActive, importTaskLabel, type ImportTaskView } from '../import/import-task-projection';
import { libraryBookPreviewHandlers } from './library-book-preview';
import {
  LibraryImportTaskActions,
  LibraryImportTaskCard,
  LibraryImportTaskListRow,
  LibraryImportTaskOverlay,
} from './LibraryImportTaskItems';

interface LibraryBookItemProps extends LibraryScreenProps {
  readonly book: LibraryBookView;
  readonly importTask?: ImportTaskView;
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
  void actions.books.open(book.novel);
}

function BookItemActions({ book, model, actions, importTask }: LibraryBookItemProps) {
  if (model.management.selectionMode) return null;
  const { novel } = book;
  const trashed = Boolean(novel.deletedAt);
  const importing = Boolean(importTask && importTaskIsActive(importTask));

  if (trashed) {
    return (
      <div className="card-actions">
        <button
          type="button"
          className="mini-icon-btn"
          title="복원"
          aria-label={`${novel.title} 복원`}
          disabled={importing}
          onClick={() => void actions.books.restore(novel)}
        >
          <RotateCcw size={15} />
        </button>
        <button
          type="button"
          className="mini-icon-btn danger"
          title="영구 삭제"
          aria-label={`${novel.title} 영구 삭제`}
          disabled={importing}
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
        disabled={importing}
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
        disabled={importing}
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
        disabled={importing}
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

function LibraryBookCard(props: LibraryBookItemProps) {
  const { book, model, importTask } = props;
  const { trashed, selected, focused } = useItemState(props);

  return (
    <article
      {...libraryBookPreviewHandlers(book.novel, model, props.actions.presentation)}
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
        {importTask && <LibraryImportTaskOverlay task={importTask} compact />}
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
          <strong>
            {importTask ? (
              importTaskLabel(importTask)
            ) : trashed ? (
              '휴지통'
            ) : model.presentation.showReadingCounts && book.readingCounts ? (
              <LibraryCountLabel {...book.readingCounts} />
            ) : (
              formatProgress(book.bookProgress)
            )}
          </strong>
          <span>{book.lastReadLabel}</span>
          {importTask?.phase === 'failed' ? (
            <LibraryImportTaskActions task={importTask} actions={props.actions} />
          ) : (
            <BookItemActions {...props} />
          )}
        </div>
      </div>
    </article>
  );
}

function LibraryBookListRow(props: LibraryBookItemProps) {
  const { book, model, importTask } = props;
  const { trashed, selected, focused } = useItemState(props);

  return (
    <article
      {...libraryBookPreviewHandlers(book.novel, model, props.actions.presentation)}
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
      {model.viewMode !== 'text' && (
        <div className="book-cover-wrap">
          <BookCover novel={book.novel} className={classNames('book-cover thumb', book.coverClass)}>
            {model.management.selectionMode && <SelectionMark selected={selected} />}
            {!model.management.selectionMode && (
              <span className="book-format-overlay">{bookFormatLabel(book.novel)}</span>
            )}
          </BookCover>
          {importTask && <LibraryImportTaskOverlay task={importTask} compact />}
        </div>
      )}
      <div className="book-list-main">
        <div className="book-list-title">
          {model.viewMode === 'text' && model.management.selectionMode && <SelectionMark selected={selected} />}
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
        <strong>
          {importTask ? importTaskLabel(importTask) : trashed ? '휴지통' : formatProgress(book.bookProgress)}
        </strong>
        <span>{book.lastReadLabel}</span>
      </div>
      {importTask?.phase === 'failed' ? (
        <LibraryImportTaskActions task={importTask} actions={props.actions} />
      ) : (
        <BookItemActions {...props} />
      )}
    </article>
  );
}

export function LibraryBookCollection(props: LibraryScreenProps) {
  const collectionClass = isCoverView(props.model.viewMode) ? 'books-grid' : 'books-list';
  const externalWorks = props.model.externalSources.libraryWorks ?? [];
  const tasks = props.model.importTasks.filter((task) => task.phase !== 'complete');
  const taskForBook = (bookId: string) => tasks.find((task) => task.targetBookId === bookId);
  const taskForExternalWork = (workId: string) => tasks.find((task) => task.externalWorkId === workId);
  const visibleBookIds = new Set(props.model.collection.visibleBooks.map((book) => book.novel.id));
  const visibleExternalWorkIds = new Set(externalWorks.map((work) => work.id));
  const boundTaskIds = new Set(
    tasks
      .filter(
        (task) =>
          Boolean(task.targetBookId && visibleBookIds.has(task.targetBookId)) ||
          Boolean(task.externalWorkId && visibleExternalWorkIds.has(task.externalWorkId)),
      )
      .map((task) => task.id),
  );
  const query = props.model.query.trim().toLocaleLowerCase();
  const standaloneTasks =
    !props.model.management.selectionMode && props.model.filter === 'all' && !props.model.management.activeShelfId
      ? tasks.filter(
          (task) =>
            !boundTaskIds.has(task.id) &&
            (!query || [task.title, task.fileName].some((value) => value?.toLocaleLowerCase().includes(query))),
        )
      : [];
  const items = [
    ...standaloneTasks.map((task) => ({ kind: 'task' as const, key: `task:${task.id}`, task })),
    ...props.model.collection.visibleBooks.map((book) => ({
      kind: 'book' as const,
      key: `book:${book.novel.id}`,
      book,
    })),
    ...externalWorks.map((work) => ({ kind: 'external' as const, key: `external:${work.id}`, work })),
  ];
  if (items.length > 100) {
    const renderItem = (index: number) => {
      const item = items[index];
      if (item.kind === 'task') {
        return isCoverView(props.model.viewMode) ? (
          <LibraryImportTaskCard key={item.key} task={item.task} actions={props.actions} />
        ) : (
          <LibraryImportTaskListRow key={item.key} task={item.task} actions={props.actions} />
        );
      }
      if (item.kind === 'external') {
        return isCoverView(props.model.viewMode) ? (
          <ExternalWorkCard
            showReadingCounts={props.model.presentation.showReadingCounts}
            key={item.key}
            work={item.work}
            selectionMode={props.model.management.selectionMode}
            selected={props.model.management.selectedBookIds.has(externalSelectionId(item.work.id))}
            busy={props.model.management.busy}
            actions={props.actions}
            importTask={taskForExternalWork(item.work.id)}
          />
        ) : (
          <ExternalWorkListRow
            showCover={props.model.viewMode !== 'text'}
            key={item.key}
            work={item.work}
            selectionMode={props.model.management.selectionMode}
            selected={props.model.management.selectedBookIds.has(externalSelectionId(item.work.id))}
            busy={props.model.management.busy}
            actions={props.actions}
            importTask={taskForExternalWork(item.work.id)}
          />
        );
      }
      return isCoverView(props.model.viewMode) ? (
        <LibraryBookCard key={item.key} book={item.book} importTask={taskForBook(item.book.novel.id)} {...props} />
      ) : (
        <LibraryBookListRow key={item.key} book={item.book} importTask={taskForBook(item.book.novel.id)} {...props} />
      );
    };
    return (
      <>
        {props.model.management.selectionMode && (
          <p className="sr-only" role="status" aria-live="polite">
            {props.model.management.selectedBookIds.size}권 선택됨
          </p>
        )}
        <div
          data-view={props.model.viewMode}
          className={!isCoverView(props.model.viewMode) ? 'books-list library-virtual-list-shell' : undefined}
        >
          {!isCoverView(props.model.viewMode) && (
            <div className="book-list-head">
              <span>작품</span>
              <span>전체 진행률</span>
              <span>작업</span>
            </div>
          )}
          <VirtualizedLibraryCollection
            count={items.length}
            viewMode={props.model.viewMode}
            resetKey={JSON.stringify([
              props.model.query,
              props.model.filter,
              props.model.sort,
              props.model.viewMode,
              props.model.management.activeShelfId,
            ])}
            itemKey={(index) => items[index].key}
            renderItem={renderItem}
          />
        </div>
      </>
    );
  }
  return (
    <>
      {props.model.management.selectionMode && (
        <p className="sr-only" role="status" aria-live="polite">
          {props.model.management.selectedBookIds.size}권 선택됨
        </p>
      )}
      <div className={collectionClass} data-view={props.model.viewMode} role="list" aria-label="작품 목록">
        {!isCoverView(props.model.viewMode) && (
          <div className="book-list-head" aria-hidden="true">
            <span>작품</span>
            <span>전체 진행률</span>
            <span>작업</span>
          </div>
        )}
        {standaloneTasks.map((task) =>
          isCoverView(props.model.viewMode) ? (
            <LibraryImportTaskCard key={task.id} task={task} actions={props.actions} />
          ) : (
            <LibraryImportTaskListRow key={task.id} task={task} actions={props.actions} />
          ),
        )}
        {props.model.collection.visibleBooks.map((book) =>
          isCoverView(props.model.viewMode) ? (
            <LibraryBookCard key={book.novel.id} book={book} importTask={taskForBook(book.novel.id)} {...props} />
          ) : (
            <LibraryBookListRow key={book.novel.id} book={book} importTask={taskForBook(book.novel.id)} {...props} />
          ),
        )}
        {externalWorks.map((work) =>
          isCoverView(props.model.viewMode) ? (
            <ExternalWorkCard
              showReadingCounts={props.model.presentation.showReadingCounts}
              key={work.id}
              work={work}
              selectionMode={props.model.management.selectionMode}
              selected={props.model.management.selectedBookIds.has(externalSelectionId(work.id))}
              busy={props.model.management.busy}
              actions={props.actions}
              importTask={taskForExternalWork(work.id)}
            />
          ) : (
            <ExternalWorkListRow
              showCover={props.model.viewMode !== 'text'}
              key={work.id}
              work={work}
              selectionMode={props.model.management.selectionMode}
              selected={props.model.management.selectedBookIds.has(externalSelectionId(work.id))}
              busy={props.model.management.busy}
              actions={props.actions}
              importTask={taskForExternalWork(work.id)}
            />
          ),
        )}
      </div>
    </>
  );
}
