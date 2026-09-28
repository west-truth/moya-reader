import { useEffect, useState } from 'react';
import { isCoverView } from '../../components/work-view';
import type { LibraryScreenModel, LibraryScreenProps } from './library-screen-contract';

export function sourceLibraryLoadingState(model: LibraryScreenModel) {
  if (model.filter === 'favorite' || (model.management.activeShelfId && model.filter !== 'trash')) return undefined;
  return model.externalSources.libraryBootstrap;
}

/** Occupies the same grid cell or list row as the source card that replaces it. */
export function LibrarySourcePlaceholder({ viewMode }: { viewMode: LibraryScreenModel['viewMode'] }) {
  const cover = isCoverView(viewMode);
  return (
    <div className={`${cover ? 'book-card' : 'book-list-row'} library-source-placeholder`} aria-hidden="true">
      {viewMode !== 'text' && (
        <div className="book-cover-wrap">
          <div className={`book-cover skeleton${cover ? '' : ' thumb'}`} />
        </div>
      )}
      <div className={cover ? 'book-info' : 'book-list-main'}>
        <span className="skeleton skeleton-line is-wide" />
        <span className="skeleton skeleton-line" />
      </div>
      {!cover && (
        <div className="book-list-progress">
          <span className="skeleton skeleton-line" />
        </div>
      )}
    </div>
  );
}

/** Source storage can arrive later than local books without blocking the library. */
export function LibrarySourceLoading({ model, actions }: LibraryScreenProps) {
  const state = sourceLibraryLoadingState(model);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (state?.status !== 'loading') return;
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [state]);
  if (!state || state.status === 'ready') return null;
  const failed = state.status === 'failed';
  return (
    <section className={failed || slow ? 'library-source-loading' : 'sr-only'} aria-label="소스 작품 불러오기">
      <div className="library-source-loading-status" role="status">
        <span>
          {failed
            ? '소스 작품을 불러오지 못했습니다'
            : slow
              ? '소스 작품을 불러오는 데 시간이 걸립니다'
              : '소스 작품 불러오는 중'}
        </span>
        {(failed || slow) && actions.header.retrySourceLibrary && (
          <button className="ghost-btn" onClick={actions.header.retrySourceLibrary}>
            다시 시도
          </button>
        )}
      </div>
    </section>
  );
}
