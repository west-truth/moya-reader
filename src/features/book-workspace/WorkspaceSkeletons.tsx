import { useEffect } from 'react';
import { LibraryMobileHeader, LibrarySidebar } from '../library/LibraryChrome';
import type { LibraryScreenProps } from '../library/library-screen-contract';
import { SkeletonCoverGrid, SkeletonRows } from '../../shared/ui/Skeleton';

/** Stand-in for a library-level screen whose code is still downloading; chrome stays in place. */
export function WorkspaceScreenSkeleton(props: LibraryScreenProps) {
  return (
    <main className="library-screen workspace-skeleton-screen" aria-busy="true">
      <div className="library-product-shell">
        <LibrarySidebar {...props} />
        <section className="library-workspace">
          <LibraryMobileHeader {...props} />
          <div className="workspace-skeleton-topbar" aria-hidden="true" />
          <div className="workspace-skeleton-body" role="status" aria-label="화면을 여는 중">
            <SkeletonCoverGrid />
          </div>
        </section>
      </div>
    </main>
  );
}

/** Book detail placeholder: cover, title lines and chapter rows in their final positions. */
export function BookDetailSkeleton() {
  return (
    <main className="chapters-screen" aria-busy="true">
      <div className="book-detail-main book-detail-skeleton" role="status" aria-label="작품 정보를 여는 중">
        <div className="book-detail-skeleton-hero" aria-hidden="true">
          <span className="skeleton book-detail-skeleton-cover" />
          <span className="book-detail-skeleton-copy">
            <span className="skeleton skeleton-line is-short" />
            <span className="skeleton skeleton-line is-title" />
            <span className="skeleton skeleton-line is-wide" />
            <span className="skeleton skeleton-button" />
          </span>
        </div>
        <SkeletonRows />
      </div>
    </main>
  );
}

/**
 * Warms the code for screens one tap away once the app is idle, so pushes rarely wait on
 * the network; the skeletons above cover the remaining cold loads.
 */
export function useIdleScreenPreload(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const preload = () => {
      void import('../chapters/ChaptersScreen');
      void import('../reader/ReaderScreen');
      void import('../discovery/DiscoveryScreen');
      void import('../external-sources/SourceHubScreen');
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(preload, { timeout: 4000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(preload, 1500);
    return () => window.clearTimeout(timer);
  }, [enabled]);
}
