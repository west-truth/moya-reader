import { useCallback, useEffect, useRef } from 'react';
import type { Chapter, Novel } from '../../domain/types';
import { DebouncedProgressPersistence } from '../reader/reader-progress-controller';

export function useFixedDocumentProgress(
  pageIndex: number,
  chapter: Chapter | undefined,
  novel: Novel,
  save: (pageIndex: number, chapter: Chapter, novel: Novel) => void | Promise<void>,
): () => Promise<void> {
  const latest = useRef({ pageIndex, chapter, novel, save });
  latest.current = { pageIndex, chapter, novel, save };
  const persistence = useRef<DebouncedProgressPersistence<() => void | Promise<void>>>();
  if (!persistence.current) {
    persistence.current = new DebouncedProgressPersistence(
      { set: (callback, delay) => window.setTimeout(callback, delay), clear: (id) => window.clearTimeout(id) },
      350,
      async (commit) => {
        await commit();
      },
    );
  }
  const flush = useCallback(() => persistence.current!.flush(), []);
  useEffect(() => {
    const current = latest.current;
    if (current.chapter) {
      persistence.current!.schedule(() => current.save(current.pageIndex, current.chapter!, current.novel));
    }
  }, [pageIndex, chapter?.id, novel.id, novel.activeContentRevisionId]);
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    const onPageHide = () => {
      void flush();
    };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
      void flush();
    };
  }, [flush]);
  return flush;
}
