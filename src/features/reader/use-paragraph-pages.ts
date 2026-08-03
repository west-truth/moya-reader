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
  const [, setRevision] = useState(0);
  const mountedRef = useRef(true);
  const ownerRef = useRef<ParagraphPageCacheOwner>();
  if (!ownerRef.current) ownerRef.current = new ParagraphPageCacheOwner();
  const owner = ownerRef.current;
  const cache = owner.acquire(chapterId, () => {
    const created = new ParagraphPageCache(PARAGRAPHS_PER_PAGE, () => {
      if (mountedRef.current && owner.isActive(created)) setRevision((value) => value + 1);
    });
    return created;
  });

  const loadIndexes = useCallback(
    (indexes: readonly number[]) => cache.loadIndexes(chapterId, indexes, repository.getParagraphPage.bind(repository)),
    [cache, chapterId, repository],
  );

  const retryPage = useCallback(
    (pageIndex: number) => cache.retryPage(chapterId, pageIndex, repository.getParagraphPage.bind(repository)),
    [cache, chapterId, repository],
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

  useEffect(
    () => () => {
      mountedRef.current = false;
      owner.dispose();
    },
    [owner],
  );

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
