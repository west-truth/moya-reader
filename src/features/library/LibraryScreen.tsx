import { FileText, Library, Play, Plus, RotateCcw, Search, Upload } from 'lucide-react';
import type { DragEvent } from 'react';
import { formatProgress } from '../../utils/format';
import { BookCover } from './BookCover';
import { LibraryBatchBar } from './LibraryBatchBar';
import { LibraryBookCollection } from './LibraryBookCollection';
import { LibraryHeader, LibraryMobileHeader, LibrarySidebar } from './LibraryChrome';
import { LibraryControls } from './LibraryControls';
import { LibraryInspector } from './LibraryInspector';
import { LibraryReadingProgress } from './LibraryReadingProgress';
import type { LibraryScreenProps } from './library-screen-contract';

export type { LibraryScreenActions, LibraryScreenModel, LibraryScreenProps } from './library-screen-contract';

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function RecentReadingBand({ model, actions }: LibraryScreenProps) {
  const book = model.collection.featuredBook;
  if (!book) return null;
  return (
    <section className="recent-band" aria-label="최근 읽던 작품">
      <BookCover novel={book.novel} className={classNames('book-cover', book.coverClass)} />
      <div className="recent-copy">
        <span className="eyebrow">최근 읽던 작품</span>
        <h2>{book.novel.title}</h2>
        <p>{[book.novel.author, book.readingPositionLabel, book.lastReadLabel].filter(Boolean).join(' · ')}</p>
      </div>
      <div className="recent-progress">
        <div>
          <strong>{formatProgress(book.bookProgress)}</strong>
          <span>{book.readingPositionLabel}</span>
        </div>
        <LibraryReadingProgress
          novel={book.novel}
          progress={book.bookProgress}
          positionLabel={book.readingPositionLabel}
          className="progress-track"
        />
      </div>
      <button
        className="primary-btn"
        onClick={() => void actions.books.continueReading(book.novel)}
        aria-label={`${book.novel.title} ${book.directActionLabel}`}
      >
        <Play size={16} fill="currentColor" /> <span>{book.directActionLabel}</span>
      </button>
    </section>
  );
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
          <RotateCcw size={17} /> 다시 시도
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
        <LibrarySidebar model={model} actions={actions} />
        <section className="library-workspace">
          <LibraryMobileHeader model={model} actions={actions} />
          <LibraryHeader model={model} actions={actions} />
          <div className="library-layout">
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
