import { useEffect, useState } from 'react';
import { isCoverView } from '../../components/work-view';
import { SkeletonCoverGrid, SkeletonRows } from '../../shared/ui/Skeleton';
import type { LibraryScreenProps } from './library-screen-contract';

/** Source storage can arrive later than local books without blocking the library. */
export function LibrarySourceLoading({ model, actions }: LibraryScreenProps) {
  const state = model.externalSources.libraryBootstrap;
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
    <section className="library-source-loading" aria-label="소스 작품 불러오기">
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
      {!failed && (isCoverView(model.viewMode) ? <SkeletonCoverGrid count={4} /> : <SkeletonRows count={3} />)}
    </section>
  );
}
