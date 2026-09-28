import { useLayoutEffect, useRef } from 'react';

export type ScreenMotion = 'forward' | 'back' | 'fade';

/** A screen's identity and how deep it sits in the library → book → reader stack. */
export interface ScreenPlace {
  readonly key: string;
  readonly depth: number;
}

export function screenMotionBetween(from: ScreenPlace | undefined, to: ScreenPlace): ScreenMotion | undefined {
  if (!from || from.key === to.key) return undefined;
  if (to.depth > from.depth) return 'forward';
  if (to.depth < from.depth) return 'back';
  return 'fade';
}

/**
 * Publishes the direction of the latest screen change on the document root so the entering
 * screen can push in (deeper), pop in (shallower) or cross-fade (sibling) from CSS alone.
 * Runs before paint, so the first frame of the new screen already carries the direction.
 */
export function useScreenMotion(key: string, depth: number): void {
  const previous = useRef<ScreenPlace>();
  useLayoutEffect(() => {
    const place = { key, depth };
    const motion = screenMotionBetween(previous.current, place);
    previous.current = place;
    if (motion && typeof document !== 'undefined') document.documentElement.dataset.screenMotion = motion;
  }, [key, depth]);
}
