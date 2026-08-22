import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Paragraph } from '../../domain/types';
import type { ReaderRepository } from '../../repositories/reader-repository';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import { ParagraphPageCache } from './paragraph-page-cache';

export interface ParagraphPagesController {
  readonly revision: number;
  readonly generation: number;
  readonly reset: () => void;
  readonly loadIndexes: (paragraphIndexes: readonly number[]) => Promise<void>;
  readonly retryPage: (pageIndex: number) => Promise<void>;
  readonly prune: (visibleParagraphIndexes: readonly number[]) => void;
  readonly paragraphAt: (paragraphIndex: number) => Paragraph | undefined;
  readonly paragraphById: (paragraphId: string) => Paragraph | undefined;
  readonly getParagraphAt: (paragraphIndex: number) => Promise<Paragraph | undefined>;
  readonly isPageFailed: (pageIndex: number) => boolean;
}

interface ChapterCache {
  readonly chapterId: string;
  readonly cache: ParagraphPageCache;
}

export class ParagraphPageCacheOwner {
  private active?: ChapterCache;
  private readonly stale: ParagraphPageCache[] = [];

  acquire(chapterId: string, factory: () => ParagraphPageCache): ParagraphPageCache {
    if (this.active?.chapterId === chapterId) return this.active.cache;
    if (this.active) this.stale.push(this.active.cache);
    const cache = factory();
    this.active = { chapterId, cache };
    return cache;
  }

  isActive(cache: ParagraphPageCache): boolean {
    return this.active?.cache === cache;
  }

  disposeStale(): void {
    this.stale.splice(0).forEach((cache) => cache.dispose());
  }

  dispose(): void {
    this.disposeStale();
    this.active?.cache.dispose();
    this.active = undefined;
  }
}

export function useParagraphPages(
  repository: ReaderRepository,
  chapterId: string,
  paragraphCount: number,
): ParagraphPagesController {
  const [, setPublishedRevision] = useState<{
    readonly cache: ParagraphPageCache;
    readonly revision: number;
  }>();
  const mountedRef = useRef(true);
  const ownerRef = useRef<ParagraphPageCacheOwner>();
  if (!ownerRef.current) ownerRef.current = new ParagraphPageCacheOwner();
  const owner = ownerRef.current;
  const publishCacheRevision = useCallback(
    (target: ParagraphPageCache) => {
      if (!mountedRef.current || !owner.isActive(target)) return;
      const revision = target.snapshot().revision;
      setPublishedRevision((current) =>
        current?.cache === target && current.revision === revision ? current : { cache: target, revision },
      );
    },
    [owner],
  );
  const cache = owner.acquire(chapterId, () => {
    const created = new ParagraphPageCache(PARAGRAPHS_PER_PAGE, () => {
      publishCacheRevision(created);
    });
    return created;
  });

  const loadIndexes = useCallback(
    async (indexes: readonly number[]) => {
      await cache.loadIndexes(chapterId, indexes, repository.getParagraphPage.bind(repository));
      // The cache callback normally publishes during the load. Publishing once more
      // after the promise settles closes the first-paint race where content is cached
      // between React's effect flush and the virtualizer's initial measurement.
      publishCacheRevision(cache);
    },
    [cache, chapterId, publishCacheRevision, repository],
  );

  const retryPage = useCallback(
    async (pageIndex: number) => {
      await cache.retryPage(chapterId, pageIndex, repository.getParagraphPage.bind(repository));
      publishCacheRevision(cache);
    },
    [cache, chapterId, publishCacheRevision, repository],
  );

  const getParagraphAt = useCallback(
    async (index: number) => {
      if (index < 0 || index >= paragraphCount) return undefined;
      const cached = cache.paragraphAt(index);
      if (cached) return cached;
      await loadIndexes([index]);
      return cache.paragraphAt(index);
    },
    [cache, loadIndexes, paragraphCount],
  );

  useEffect(() => {
    owner.disposeStale();
  }, [chapterId, owner]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // React StrictMode immediately runs effect cleanup and setup once more in
      // development. Deferring disposal by one microtask keeps that probe from
      // destroying the active cache while still releasing it after a real
      // unmount.
      queueMicrotask(() => {
        if (!mountedRef.current) owner.dispose();
      });
    };
  }, [owner]);

  const snapshot = cache.snapshot();
  return useMemo(
    () => ({
      revision: snapshot.revision,
      generation: snapshot.generation,
      reset: () => cache.reset(),
      loadIndexes,
      retryPage,
      prune: (indexes: readonly number[]) => cache.prune(indexes),
      paragraphAt: (index: number) => cache.paragraphAt(index),
      paragraphById: (paragraphId: string) => cache.paragraphById(paragraphId),
      getParagraphAt,
      isPageFailed: (pageIndex: number) => cache.isPageFailed(pageIndex),
    }),
    [cache, getParagraphAt, loadIndexes, retryPage, snapshot.generation, snapshot.revision],
  );
}
