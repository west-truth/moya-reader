import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Chapter } from '../../domain/types';

/** Earlier downloaded releases can shift page indexes without changing the page being read. */
export function useFixedDocumentPageAnchor(
  bookId: string,
  chapters: readonly Chapter[],
  pageIndex: number,
  goToPage: (page: number) => void,
) {
  const previous = useRef({ bookId, chapters, pageIndex });
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { bookId, chapters, pageIndex };
    if (before.bookId !== bookId || before.chapters === chapters || before.pageIndex !== pageIndex) return;
    const id = before.chapters[before.pageIndex]?.id;
    const index = id ? chapters.findIndex((chapter) => chapter.id === id) : -1;
    if (index >= 0 && index !== pageIndex) goToPage(index);
  }, [bookId, chapters, pageIndex, goToPage]);
}

/** Content refreshes are not navigation requests. Apply each explicit entry once. */
export function useFixedDocumentEntry(
  bookId: string,
  chapterId: string | undefined,
  chapters: readonly Chapter[],
  goToPage: (page: number) => void,
  requestVersion = 0,
) {
  const applied = useRef<string>();
  const key = chapterId ? JSON.stringify([bookId, chapterId, requestVersion]) : undefined;
  useEffect(() => {
    if (!key) {
      applied.current = undefined;
      return;
    }
    if (applied.current === key) return;
    const page = chapters.findIndex((chapter) => chapter.id === chapterId);
    if (page < 0) return;
    applied.current = key;
    goToPage(page);
  }, [key, chapterId, chapters, goToPage]);
}
