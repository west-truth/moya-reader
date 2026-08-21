import { useCallback, useEffect, useRef, useState, type RefObject, type WheelEvent as ReactWheelEvent } from 'react';

const END_EPSILON_PX = 2;
const END_IDLE_MS = 280;
const WHEEL_GESTURE_GAP_MS = 180;
const WHEEL_COMMIT_THRESHOLD_PX = 72;
const TOUCH_COMMIT_THRESHOLD_PX = 56;
const MAX_PULL_PX = 32;
const PULL_RELEASE_MS = 160;
const PULL_COMMIT_MS = 100;
const MOTION_CLASSES = [
  'reader-boundary-motion',
  'is-wheel-pull',
  'is-touch-pull',
  'is-boundary-release',
  'is-boundary-commit',
] as const;

function isAtScrollEnd(root: HTMLElement): boolean {
  return root.scrollHeight - root.clientHeight - root.scrollTop <= END_EPSILON_PX;
}

function wheelDeltaInPixels(event: ReactWheelEvent<HTMLElement>, viewportHeight: number): number {
  if (event.deltaMode === window.WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
  if (event.deltaMode === window.WheelEvent.DOM_DELTA_PAGE) return event.deltaY * Math.max(1, viewportHeight);
  return event.deltaY;
}

function pullOffset(delta: number, threshold: number): number {
  const progress = Math.min(1, Math.max(0, delta) / threshold);
  return MAX_PULL_PX * (1 - (1 - progress) ** 1.4);
}

export function useScrollChapterBoundary(input: {
  readonly rootRef: RefObject<HTMLElement>;
  readonly contentRef: RefObject<HTMLElement>;
  readonly chapterId: string;
  readonly enabled: boolean;
  readonly onNextChapter: () => void | Promise<void>;
}) {
  const [armed, setArmedState] = useState(false);
  const armedRef = useRef(false);
  const armTimerRef = useRef<number>();
  const pointerStartedArmedRef = useRef(false);
  const pointerStartYRef = useRef<number>();
  const transitioningRef = useRef(false);
  const wheelIntentRef = useRef({ delta: 0, lastAt: 0 });
  const wheelReleaseTimerRef = useRef<number>();
  const motionCleanupTimerRef = useRef<number>();
  const commitTimerRef = useRef<number>();
  const commitFallbackTimerRef = useRef<number>();
  const onNextChapterRef = useRef(input.onNextChapter);
  onNextChapterRef.current = input.onNextChapter;

  const setArmed = useCallback((next: boolean) => {
    armedRef.current = next;
    setArmedState(next);
  }, []);

  const clearArmTimer = useCallback(() => {
    window.clearTimeout(armTimerRef.current);
    armTimerRef.current = undefined;
  }, []);

  const clearMotionTimers = useCallback(() => {
    window.clearTimeout(wheelReleaseTimerRef.current);
    window.clearTimeout(motionCleanupTimerRef.current);
    window.clearTimeout(commitTimerRef.current);
    window.clearTimeout(commitFallbackTimerRef.current);
    wheelReleaseTimerRef.current = undefined;
    motionCleanupTimerRef.current = undefined;
    commitTimerRef.current = undefined;
    commitFallbackTimerRef.current = undefined;
  }, []);

  const clearPullMotion = useCallback(() => {
    const content = input.contentRef.current;
    if (!content) return;
    content.classList.remove(...MOTION_CLASSES);
    content.style.removeProperty('--reader-boundary-pull');
  }, [input.contentRef]);

  const setPullMotion = useCallback(
    (offset: number, phase: 'wheel' | 'touch' | 'release' | 'commit') => {
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      const content = input.contentRef.current;
      if (!content) return;
      content.classList.remove(...MOTION_CLASSES);
      content.classList.add(
        'reader-boundary-motion',
        phase === 'wheel'
          ? 'is-wheel-pull'
          : phase === 'touch'
            ? 'is-touch-pull'
            : phase === 'commit'
              ? 'is-boundary-commit'
              : 'is-boundary-release',
      );
      content.style.setProperty('--reader-boundary-pull', `${Math.max(0, Math.min(MAX_PULL_PX, offset)).toFixed(2)}px`);
    },
    [input.contentRef],
  );

  const releasePull = useCallback(() => {
    window.clearTimeout(wheelReleaseTimerRef.current);
    window.clearTimeout(motionCleanupTimerRef.current);
    wheelReleaseTimerRef.current = undefined;
    const content = input.contentRef.current;
    if (!content || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      clearPullMotion();
      return;
    }
    setPullMotion(0, 'release');
    motionCleanupTimerRef.current = window.setTimeout(clearPullMotion, PULL_RELEASE_MS + 40);
  }, [clearPullMotion, input.contentRef, setPullMotion]);

  const resetWheelIntent = useCallback(() => {
    wheelIntentRef.current = { delta: 0, lastAt: 0 };
  }, []);

  const disarm = useCallback(() => {
    clearArmTimer();
    resetWheelIntent();
    pointerStartedArmedRef.current = false;
    pointerStartYRef.current = undefined;
    setArmed(false);
    releasePull();
  }, [clearArmTimer, releasePull, resetWheelIntent, setArmed]);

  const scheduleArm = useCallback(() => {
    clearArmTimer();
    if (!input.enabled || transitioningRef.current) {
      setArmed(false);
      return;
    }
    setArmed(false);
    armTimerRef.current = window.setTimeout(() => {
      const root = input.rootRef.current;
      if (root && isAtScrollEnd(root) && !transitioningRef.current) setArmed(true);
    }, END_IDLE_MS);
  }, [clearArmTimer, input.enabled, input.rootRef, setArmed]);

  const commitNextChapter = useCallback(() => {
    if (transitioningRef.current) return;
    transitioningRef.current = true;
    clearArmTimer();
    clearMotionTimers();
    resetWheelIntent();
    pointerStartedArmedRef.current = false;
    pointerStartYRef.current = undefined;
    setArmed(false);
    const finish = () => {
      void Promise.resolve()
        .then(() => onNextChapterRef.current())
        .then(() => {
          transitioningRef.current = false;
          commitFallbackTimerRef.current = window.setTimeout(() => {
            if (input.contentRef.current?.isConnected) releasePull();
          }, 500);
        })
        .catch(() => {
          transitioningRef.current = false;
          releasePull();
        });
    };
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      clearPullMotion();
      finish();
      return;
    }
    setPullMotion(MAX_PULL_PX, 'commit');
    commitTimerRef.current = window.setTimeout(finish, PULL_COMMIT_MS);
  }, [
    clearArmTimer,
    clearMotionTimers,
    clearPullMotion,
    input.contentRef,
    releasePull,
    resetWheelIntent,
    setArmed,
    setPullMotion,
  ]);

  const scheduleWheelRelease = useCallback(() => {
    window.clearTimeout(wheelReleaseTimerRef.current);
    wheelReleaseTimerRef.current = window.setTimeout(() => {
      resetWheelIntent();
      releasePull();
    }, WHEEL_GESTURE_GAP_MS);
  }, [releasePull, resetWheelIntent]);

  const onScroll = useCallback(() => {
    const root = input.rootRef.current;
    if (!input.enabled || !root || !isAtScrollEnd(root)) {
      disarm();
      return;
    }
    if (!armedRef.current) scheduleArm();
  }, [disarm, input.enabled, input.rootRef, scheduleArm]);

  const onWheel = useCallback(
    (event: ReactWheelEvent<HTMLElement>) => {
      if (event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
      const root = input.rootRef.current;
      if (!input.enabled || !root) return;
      const delta = wheelDeltaInPixels(event, root.clientHeight);
      if (delta <= 0) {
        if (armedRef.current || isAtScrollEnd(root)) disarm();
        return;
      }
      if (!isAtScrollEnd(root)) return;
      if (!armedRef.current) {
        // Momentum from the gesture that reached the end keeps postponing the arm.
        // Only a later wheel gesture after the idle window can turn the chapter.
        scheduleArm();
        return;
      }
      event.preventDefault();
      const now = window.performance.now();
      const intent = wheelIntentRef.current;
      if (now - intent.lastAt > WHEEL_GESTURE_GAP_MS) intent.delta = 0;
      intent.delta += delta;
      intent.lastAt = now;
      setPullMotion(pullOffset(intent.delta, WHEEL_COMMIT_THRESHOLD_PX), 'wheel');
      scheduleWheelRelease();
      if (intent.delta >= WHEEL_COMMIT_THRESHOLD_PX) commitNextChapter();
    },
    [commitNextChapter, disarm, input.enabled, input.rootRef, scheduleArm, scheduleWheelRelease, setPullMotion],
  );

  const onPointerDown = useCallback(
    (clientY: number): boolean => {
      const root = input.rootRef.current;
      const ready = Boolean(
        input.enabled && armedRef.current && root && isAtScrollEnd(root) && !transitioningRef.current,
      );
      pointerStartedArmedRef.current = ready;
      pointerStartYRef.current = clientY;
      if (root && isAtScrollEnd(root) && !armedRef.current) scheduleArm();
      return ready;
    },
    [input.enabled, input.rootRef, scheduleArm],
  );

  const onPointerMove = useCallback(
    (clientY: number): boolean => {
      if (!pointerStartedArmedRef.current || transitioningRef.current || pointerStartYRef.current === undefined)
        return false;
      const delta = pointerStartYRef.current - clientY;
      setPullMotion(pullOffset(delta, TOUCH_COMMIT_THRESHOLD_PX), 'touch');
      return delta > 0;
    },
    [setPullMotion],
  );

  const onVerticalGesture = useCallback(
    (deltaY: number) => {
      const root = input.rootRef.current;
      const canCommit =
        input.enabled &&
        pointerStartedArmedRef.current &&
        deltaY >= TOUCH_COMMIT_THRESHOLD_PX &&
        Boolean(root && isAtScrollEnd(root));
      pointerStartedArmedRef.current = false;
      if (canCommit) {
        commitNextChapter();
      } else if (root && isAtScrollEnd(root)) {
        releasePull();
        scheduleArm();
      }
    },
    [commitNextChapter, input.enabled, input.rootRef, releasePull, scheduleArm],
  );

  const onPointerEnd = useCallback(() => {
    if (transitioningRef.current) return;
    pointerStartedArmedRef.current = false;
    pointerStartYRef.current = undefined;
    releasePull();
  }, [releasePull]);

  useEffect(() => {
    transitioningRef.current = false;
    clearMotionTimers();
    clearPullMotion();
    clearArmTimer();
    resetWheelIntent();
    pointerStartedArmedRef.current = false;
    pointerStartYRef.current = undefined;
    setArmed(false);
    return () => {
      clearMotionTimers();
      clearPullMotion();
      clearArmTimer();
    };
  }, [clearArmTimer, clearMotionTimers, clearPullMotion, input.chapterId, input.enabled, resetWheelIntent, setArmed]);

  return { armed, onScroll, onWheel, onPointerDown, onPointerMove, onPointerEnd, onVerticalGesture };
}
