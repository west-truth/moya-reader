import { type RefObject, useLayoutEffect, useState } from 'react';

const EXIT_FALLBACK_MS = 450;

function runsExitAnimation(element: HTMLElement | null): element is HTMLElement {
  if (!element || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return false;
  const style = window.getComputedStyle(element);
  if (!style.animationName || style.animationName === 'none') return false;
  return style.animationDuration.split(',').some((duration) => Number.parseFloat(duration) > 0);
}

/**
 * Keeps a closing layer mounted until its exit animation (declared in CSS for
 * `[data-state='closed']`) finishes. Without a running animation — tests, reduced
 * motion, unsupported engines — the layer unmounts before the next paint.
 */
export function usePresence(open: boolean, layerRef: RefObject<HTMLElement>): { present: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  useLayoutEffect(() => {
    if (open || !mounted) return;
    const element = layerRef.current;
    if (!runsExitAnimation(element)) {
      setMounted(false);
      return;
    }
    const finish = (event?: AnimationEvent) => {
      if (!event || event.target === element) setMounted(false);
    };
    const fallback = window.setTimeout(finish, EXIT_FALLBACK_MS);
    element.addEventListener('animationend', finish);
    element.addEventListener('animationcancel', finish);
    return () => {
      window.clearTimeout(fallback);
      element.removeEventListener('animationend', finish);
      element.removeEventListener('animationcancel', finish);
    };
  }, [layerRef, mounted, open]);

  return { present: open || mounted, closing: !open && mounted };
}
