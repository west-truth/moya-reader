import { elementScroll, observeElementOffset, type VirtualItem, type Virtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, type RefObject } from 'react';

type ReaderVirtualizer = Virtualizer<HTMLDivElement, Element>;
const SETTLE_MS = 250;
const EPSILON = 2;

// DOM scroll coordinates and measured document coordinates may temporarily differ.
// Move the rows by the opposite size delta while native scrolling owns the viewport;
// rebase both coordinates together after it settles, without moving the visible text.
export function useReaderScrollPosition(
  rootRef: RefObject<HTMLDivElement>,
  contentRef: RefObject<HTMLElement>,
  active: boolean,
) {
  const state = useRef({
    shift: 0,
    pinned: false,
    touching: false,
    scrolling: false,
    lastY: 0,
    offset: 0,
    max: 0,
    generation: 0,
    navigation: true,
  });
  const instanceRef = useRef<ReaderVirtualizer>();
  const pendingRebase = useRef<number>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [, render] = useReducer((value: number) => value + 1, 0);
  const enabled = useRef(active);
  enabled.current = active;

  const beginNavigation = useCallback(() => {
    const current = state.current;
    current.pinned = false;
    current.navigation = true;
    return ++current.generation;
  }, []);
  const isCurrentNavigation = useCallback(
    (generation: number) => state.current.navigation && state.current.generation === generation,
    [],
  );
  const cancelNavigation = useCallback(() => {
    state.current.navigation = false;
    state.current.generation += 1;
    // Replace the library's pending index/smooth target through its public API.
    // scrollTo is fenced above, so this cancels reconciliation without writing
    // scrollTop or stopping the browser's own gesture.
    instanceRef.current?.scrollToOffset((rootRef.current?.scrollTop ?? 0) + state.current.shift, { behavior: 'auto' });
  }, [rootRef]);
  const resetMeasurements = useCallback(() => {
    clearTimeout(timer.current);
    pendingRebase.current = undefined;
    state.current.shift = 0;
    if (instanceRef.current) instanceRef.current.scrollOffset = rootRef.current?.scrollTop ?? 0;
  }, [rootRef]);
  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    const current = state.current;
    if (!enabled.current || current.touching || current.scrolling || (!current.shift && !current.pinned)) return;
    timer.current = setTimeout(() => {
      const root = rootRef.current;
      if (!root || !enabled.current || current.touching || current.scrolling) return;
      const max = Math.max(0, root.scrollHeight - root.clientHeight);
      if (root.scrollTop < 0 || root.scrollTop > max + EPSILON) return;
      const target = (current.pinned ? max : root.scrollTop) + current.shift;
      if (!current.shift && Math.abs(root.scrollTop - target) <= EPSILON) return;
      pendingRebase.current = target;
      current.shift = 0;
      // Keep range selection at the same document position during the commit.
      if (instanceRef.current) instanceRef.current.scrollOffset = target;
      render();
    }, SETTLE_MS);
  }, [rootRef]);

  useLayoutEffect(() => {
    const target = pendingRebase.current;
    if (target === undefined) return;
    pendingRebase.current = undefined;
    // The rows and sizer have just committed their unshifted positions. A layout
    // effect changes scrollTop before paint, so this is not a visible correction.
    if (rootRef.current) rootRef.current.scrollTop = target;
  });

  const observeOffset = useCallback(
    (instance: ReaderVirtualizer, callback: (offset: number, scrolling: boolean) => void) => {
      instanceRef.current = instance;
      return observeElementOffset(instance, (offset, scrolling) => {
        const current = state.current;
        const root = rootRef.current;
        if (root && enabled.current) {
          const max = Math.max(0, root.scrollHeight - root.clientHeight);
          if (scrolling && max > 0 && offset >= max - EPSILON) current.pinned = true;
          else if (offset < current.offset - EPSILON && offset < max - EPSILON && max === current.max)
            current.pinned = false;
          current.offset = offset;
          current.max = max;
        }
        current.scrolling = scrolling;
        callback(offset + current.shift, scrolling);
        schedule();
      });
    },
    [rootRef, schedule],
  );

  const adjustMeasuredSize = useCallback(
    (item: VirtualItem, delta: number, instance: ReaderVirtualizer) => {
      const offset = instance.scrollOffset ?? 0;
      // Use the visible row identity, not stale item.end coordinates. Multiple
      // ResizeObserver entries share the old measurement batch; increasing the
      // offset for one must not make later, below-screen rows look "above" it.
      if (item.index < (instance.range?.startIndex ?? 0)) {
        state.current.shift += delta;
        instance.scrollOffset = offset + delta;
        schedule();
      }
      // Own the compensation here: the library's immediate Android scroll write
      // and delayed iOS write would both compete with native momentum.
      return false;
    },
    [schedule],
  );

  const scrollTo = useCallback(
    (offset: number, options: Parameters<typeof elementScroll>[1], instance: ReaderVirtualizer) => {
      // A late scrollToIndex reconciliation must not chase an old restore/search
      // target after the user has taken over scrolling.
      if (!state.current.navigation && options.adjustments === undefined) return;
      state.current.pinned = false;
      if (state.current.shift || pendingRebase.current !== undefined) {
        // A jump to the start may be outside the temporarily shifted native
        // range. Commit its destination and the unshifted rows together; an old
        // idle rebase must not overwrite the newly requested destination.
        clearTimeout(timer.current);
        pendingRebase.current = offset + (options.adjustments ?? 0);
        state.current.shift = 0;
        instance.scrollOffset = pendingRebase.current;
        render();
      } else elementScroll(offset, options, instance);
    },
    [],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !active) return;
    const current = state.current;
    const touchStart = (event: TouchEvent) => {
      cancelNavigation();
      state.current.touching = true;
      state.current.lastY = event.touches[0]?.clientY ?? 0;
      clearTimeout(timer.current);
    };
    const touchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y === undefined) return;
      if (y > state.current.lastY + 1) state.current.pinned = false;
      state.current.lastY = y;
    };
    const touchEnd = () => {
      state.current.touching = false;
      schedule();
    };
    const wheel = (event: WheelEvent) => {
      cancelNavigation();
      if (event.deltaY < 0) state.current.pinned = false;
    };
    const key = (event: KeyboardEvent) => {
      if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
      cancelNavigation();
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey))
        state.current.pinned = false;
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
      clearTimeout(timer.current);
      current.touching = false;
      current.pinned = false;
      observer?.disconnect();
      root.removeEventListener('touchstart', touchStart);
      root.removeEventListener('touchmove', touchMove);
      root.removeEventListener('touchend', touchEnd);
      root.removeEventListener('touchcancel', touchEnd);
      root.removeEventListener('wheel', wheel);
      root.removeEventListener('keydown', key);
    };
  }, [active, cancelNavigation, contentRef, rootRef, schedule]);

  return {
    observeOffset,
    scrollTo,
    adjustMeasuredSize,
    beginNavigation,
    isCurrentNavigation,
    resetMeasurements,
    get shift() {
      return state.current.shift;
    },
  };
}
