import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ReaderViewportApi } from './ReaderViewport';
import { autoReadingRate, isAutoReadingMode, type AutoReadingMode } from './auto-reading-modes';

const SPEED_KEY = 'moya.reader-auto-scroll-speed.v1';
const MODE_KEY = 'moya.reader-auto-scroll-mode.v1';
function savedMode(): AutoReadingMode {
  try {
    const value = localStorage.getItem(MODE_KEY);
    return isAutoReadingMode(value) ? value : 'pixel';
  } catch {
    return 'pixel';
  }
}
function savedSpeed(): number {
  try {
    const value = Number(localStorage.getItem(SPEED_KEY));
    return Number.isInteger(value) && value >= 1 && value <= 12 ? value : 4;
  } catch {
    return 4;
  }
}

export function useAutoScroll(
  viewport: MutableRefObject<ReaderViewportApi | undefined>,
  scope: string,
  allowed: boolean,
  ready = true,
  nextChapter?: { scope: string; open: (isCurrent: () => boolean) => Promise<void> },
) {
  const [speed, setSpeedState] = useState(savedSpeed);
  const [mode, setModeState] = useState<AutoReadingMode>(savedMode);
  const [continueChapter, setContinueChapter] = useState(false);
  const [started, setStarted] = useState(false);
  const running = allowed && started;
  const owner = useRef(scope);
  const pending = useRef<{ scope: string; deadline: number }>();
  const latest = useRef({ ready, nextChapter, scope, continueChapter });
  latest.current = { ready, nextChapter, scope, continueChapter };
  const active = useRef(false);
  active.current = running;
  const stop = useCallback(() => {
    active.current = false;
    pending.current = undefined;
    setStarted(false);
    viewport.current?.resetAutoReading?.();
  }, [viewport]);
  useEffect(
    () => () => {
      active.current = false;
      pending.current = undefined;
      viewport.current?.resetAutoReading?.();
    },
    [viewport],
  );
  const setMode = (value: AutoReadingMode) => {
    if (!isAutoReadingMode(value)) return;
    stop();
    setModeState(value);
    try {
      localStorage.setItem(MODE_KEY, value);
    } catch {
      /* Optional browser preference. */
    }
  };
  const setSpeed = (value: number) => {
    if (!Number.isInteger(value) || value < 1 || value > 12) return;
    setSpeedState(value);
    try {
      localStorage.setItem(SPEED_KEY, String(value));
    } catch {
      /* Browser storage is optional. */
    }
  };

  useEffect(() => {
    if (!running) stop();
  }, [running, stop]);

  useEffect(() => {
    if (scope === owner.current) return;
    if (pending.current?.scope === scope) {
      owner.current = scope;
      pending.current = undefined;
    } else stop();
  }, [scope, stop]);

  useEffect(() => {
    if (!running || typeof document === 'undefined') return;
    let frame = 0;
    let previous: number | undefined;
    let remainder = 0;
    let endSince: number | undefined;
    let initializedBlindScope: string | undefined;
    const tick = (now: number) => {
      if (!active.current) return;
      // Drop stalled/background time rather than jumping forward to catch up.
      const elapsed = previous === undefined ? 0 : Math.min(64, Math.max(0, now - previous));
      previous = now;
      if (pending.current) {
        if (Date.now() > pending.current.deadline) {
          stop();
          return;
        }
        frame = requestAnimationFrame(tick);
        return;
      }
      if (!latest.current.ready || latest.current.scope !== owner.current) {
        endSince = undefined;
        frame = requestAnimationFrame(tick);
        return;
      }
      if (mode.startsWith('blind-') && initializedBlindScope !== latest.current.scope) {
        const initialized = viewport.current?.advanceAutoReading?.(mode, 0);
        if (initialized === 'moving') initializedBlindScope = latest.current.scope;
      }
      remainder += (elapsed * autoReadingRate(mode, speed)) / 1000;
      const pixels = Math.floor(remainder);
      remainder -= pixels;
      if (pixels > 0 || endSince !== undefined) {
        const result =
          mode === 'pixel'
            ? viewport.current?.advanceAutoScroll?.(pixels)
            : viewport.current?.advanceAutoReading?.(mode, pixels);
        if (!result) {
          stop();
          return;
        }
        if (result === 'end') {
          endSince ??= now;
          // Let delayed row/image measurements settle before leaving this chapter.
          if (now - endSince >= 750) {
            const next = latest.current.continueChapter ? latest.current.nextChapter : undefined;
            if (!next || next.scope === owner.current) {
              stop();
              return;
            }
            const request = { scope: next.scope, deadline: Date.now() + 30000 };
            pending.current = request;
            endSince = undefined;
            void next
              .open(() => active.current && pending.current === request)
              .catch(() => {
                if (pending.current === request) stop();
              });
          }
        } else endSince = undefined;
      }
      frame = requestAnimationFrame(tick);
    };
    const interrupt = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[data-auto-scroll-controls]')) return;
      stop();
    };
    const hide = () => {
      if (document.hidden) stop();
    };
    frame = requestAnimationFrame(tick);
    for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown']) {
      document.addEventListener(event, interrupt, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('blur', stop);
    window.addEventListener('resize', stop);
    return () => {
      cancelAnimationFrame(frame);
      for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown']) {
        document.removeEventListener(event, interrupt, true);
      }
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('blur', stop);
      window.removeEventListener('resize', stop);
    };
  }, [running, speed, mode, stop, viewport]);

  return {
    running,
    speed,
    mode,
    setMode,
    continueChapter,
    setContinueChapter,
    setSpeed,
    stop,
    start: () => {
      if (allowed && ready && !document.hidden) {
        owner.current = scope;
        setStarted(true);
      }
    },
  };
}
