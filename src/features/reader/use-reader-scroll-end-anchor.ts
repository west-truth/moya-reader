import { elementScroll, observeElementOffset, type Virtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useRef, type RefObject } from 'react';

const SETTLE_MS = 220;
const END_EPSILON = 2;
type ReaderVirtualizer = Virtualizer<HTMLDivElement, Element>;

// Keep an end reached by native scrolling through late paragraph measurements.
// Apply one final correction after momentum settles, never during an active touch.
export function useReaderScrollEndAnchor(
  rootRef: RefObject<HTMLDivElement>,
  contentRef: RefObject<HTMLElement>,
  active: boolean,
) {
  const state = useRef({ pinned: false, touching: false, lastY: 0, offset: 0, max: 0 });
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const enabled = useRef(active);
  enabled.current = active;
  const release = useCallback(() => {
    state.current.pinned = false;
    clearTimeout(timer.current);
  }, []);
  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    if (!enabled.current || !state.current.pinned || state.current.touching) return;
    timer.current = setTimeout(() => {
      const root = rootRef.current;
      if (!root || !enabled.current || !state.current.pinned || state.current.touching) return;
      const max = Math.max(0, root.scrollHeight - root.clientHeight);
      // Let elastic overscroll return naturally before making a DOM scroll write.
      if (root.scrollTop < 0 || root.scrollTop > max + END_EPSILON) return;
      if (Math.abs(root.scrollTop - max) > END_EPSILON) root.scrollTop = max;
    }, SETTLE_MS);
  }, [rootRef]);

  const observeOffset = useCallback(
    (instance: ReaderVirtualizer, callback: (offset: number, scrolling: boolean) => void) =>
      observeElementOffset(instance, (offset, scrolling) => {
        const root = rootRef.current;
        if (root && enabled.current) {
          const current = state.current;
          const max = Math.max(0, root.scrollHeight - root.clientHeight);
          if (scrolling && max > 0 && offset >= max - END_EPSILON) current.pinned = true;
          else if (
            offset < current.offset - END_EPSILON &&
            offset < max - END_EPSILON &&
            current.offset <= current.max + END_EPSILON &&
            max === current.max
          )
            release();
          current.offset = offset;
          current.max = max;
          schedule();
        }
        callback(offset, scrolling);
      }),
    [release, rootRef, schedule],
  );

  const scrollTo = useCallback(
    (offset: number, options: Parameters<typeof elementScroll>[1], instance: ReaderVirtualizer) => {
      if (options.adjustments !== undefined && state.current.pinned && enabled.current) {
        // TanStack's deferred iOS delta describes an earlier estimate. At the end,
        // use the final DOM extent instead, including the heading/footer and padding.
        schedule();
        return;
      }
      if (options.adjustments === undefined) release();
      elementScroll(offset, options, instance);
    },
    [release, schedule],
  );

  useEffect(() => {
    const root = rootRef.current;
    release();
    state.current.touching = false;
    if (!root || !active) return;
    const touchStart = (event: TouchEvent) => {
      state.current.touching = true;
      state.current.lastY = event.touches[0]?.clientY ?? 0;
      clearTimeout(timer.current);
    };
    const touchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y === undefined) return;
      if (y > state.current.lastY + 1) release();
      state.current.lastY = y;
    };
    const touchEnd = () => {
      state.current.touching = false;
      schedule();
    };
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0) release();
    };
    const key = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) release();
    };
    root.addEventListener('touchstart', touchStart, { passive: true });
    root.addEventListener('touchmove', touchMove, { passive: true });
    root.addEventListener('touchend', touchEnd, { passive: true });
    root.addEventListener('touchcancel', touchEnd, { passive: true });
    root.addEventListener('wheel', wheel, { passive: true });
    root.addEventListener('keydown', key);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    if (contentRef.current) observer?.observe(contentRef.current);
    observer?.observe(root);
    return () => {
      release();
      observer?.disconnect();
      root.removeEventListener('touchstart', touchStart);
      root.removeEventListener('touchmove', touchMove);
      root.removeEventListener('touchend', touchEnd);
      root.removeEventListener('touchcancel', touchEnd);
      root.removeEventListener('wheel', wheel);
      root.removeEventListener('keydown', key);
    };
  }, [active, contentRef, release, rootRef, schedule]);

  return { observeOffset, scrollTo };
}
