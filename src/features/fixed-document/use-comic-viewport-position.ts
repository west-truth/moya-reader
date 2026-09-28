import { useEffect, useRef, type RefObject } from 'react';
export interface ComicViewportPosition {
  page: number;
  fraction: number;
  ratio: number;
}
/** Optional viewport persistence for transient documents; normal library progress remains unchanged. */
export function useComicViewportPosition(input: {
  identity: string;
  continuous: boolean;
  page: number;
  ready: boolean;
  viewport: RefObject<HTMLElement>;
  content: RefObject<HTMLElement>;
  initial?: ComicViewportPosition;
  save?: (position: ComicViewportPosition) => void;
}) {
  const callback = useRef(input.save);
  callback.current = input.save;
  useEffect(() => {
    if (!input.continuous && input.ready) callback.current?.({ page: input.page, fraction: 0, ratio: 1.5 });
  }, [input.continuous, input.ready, input.page, input.identity]);
  useEffect(() => {
    const root = input.viewport.current,
      body = input.content.current;
    if (!input.save || !input.continuous || !root || !body) return;
    const save = input.save;
    let restored = !input.initial;
    let restoring = Boolean(input.initial);
    let latest: ComicViewportPosition | undefined;
    let frame = 0,
      timer = 0;
    const capture = () => {
      if (!restored) return;
      const top = root.getBoundingClientRect().top;
      const row = [...body.querySelectorAll<HTMLElement>('article[data-page-index]')].find(
        (row) => row.getBoundingClientRect().bottom > top,
      );
      if (!row?.querySelector<HTMLImageElement>('img')?.naturalWidth) return;
      const bounds = row.getBoundingClientRect();
      latest = {
        page: Number(row.dataset.pageIndex),
        fraction: Math.max(0, Math.min(0.999999, (top - bounds.top) / bounds.height)),
        ratio: bounds.height / bounds.width,
      };
    };
    const flush = () => {
      if (latest) save(latest);
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (restoring && input.initial) {
            const row = body.querySelector<HTMLElement>(`article[data-page-index="${input.initial.page}"]`);
            if (!row?.querySelector<HTMLImageElement>('img')?.naturalWidth) return;
            root.scrollTop +=
              row.getBoundingClientRect().top -
              root.getBoundingClientRect().top +
              input.initial.fraction * row.getBoundingClientRect().height;
            restored = true;
          }
          capture();
          clearTimeout(timer);
          timer = window.setTimeout(flush, 200);
        });
      });
    };
    const hide = () => {
      capture();
      flush();
    };
    // Image sizes and immersive chrome can settle after the first load. Keep the
    // restored image anchor through those shifts, until the reader interacts.
    const interacted = () => {
      restoring = false;
      restored = true;
    };
    const resize = new ResizeObserver(update);
    resize.observe(root);
    resize.observe(body);
    for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown'])
      window.addEventListener(event, interacted, { capture: true, passive: true });
    root.addEventListener('load', update, true);
    root.addEventListener('scroll', update);
    window.addEventListener('pagehide', hide);
    update();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      flush();
      resize.disconnect();
      for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown'])
        window.removeEventListener(event, interacted, true);
      root.removeEventListener('load', update, true);
      root.removeEventListener('scroll', update);
      window.removeEventListener('pagehide', hide);
    };
    // The initial position and save callback belong to this entry, not later scroll renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.identity, input.continuous]);
}
