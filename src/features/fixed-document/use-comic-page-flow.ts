import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';

/** Keep episode page shells in document flow. Loading changes pixels, not page identity. */
export function useComicPageFlow(
  enabled: boolean,
  pages: readonly number[],
  viewportRef: RefObject<HTMLElement>,
  contentRef: RefObject<HTMLDivElement>,
) {
  const [nearby, setNearby] = useState<number[]>([]);
  const getRows = useCallback(
    () => Array.from(contentRef.current?.querySelectorAll<HTMLElement>('article[data-page-index]') ?? []),
    [contentRef],
  );
  const nearestPage = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const center = viewport.getBoundingClientRect().top + viewport.clientHeight / 2;
    const rows = getRows();
    const row = rows.find((element) => element.getBoundingClientRect().bottom > center) ?? rows.at(-1);
    return row ? Number(row.dataset.pageIndex) : undefined;
  }, [getRows, viewportRef]);
  const scrollToPage = useCallback(
    (page: number) => {
      const viewport = viewportRef.current;
      const element = contentRef.current?.querySelector<HTMLElement>(`article[data-page-index="${page}"]`);
      if (viewport && element) {
        viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      }
    },
    [contentRef, viewportRef],
  );
  useLayoutEffect(() => {
    if (!enabled) return;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const rect = viewport.getBoundingClientRect();
      const margin = viewport.clientHeight * 2;
      const next = getRows()
        .filter((row) => {
          const bounds = row.getBoundingClientRect();
          return bounds.bottom >= rect.top - margin && bounds.top <= rect.bottom + margin;
        })
        .map((row) => Number(row.dataset.pageIndex));
      setNearby((previous) => (previous.join(',') === next.join(',') ? previous : next));
    };
    const schedule = () => {
      frame ??= requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(content);
    observer.observe(viewport);
    viewport.addEventListener('scroll', schedule, { passive: true });
    update();
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [enabled, pages, getRows, viewportRef, contentRef]);
  return { nearby, nearestPage, scrollToPage };
}
