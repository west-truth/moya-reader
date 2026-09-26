import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { autoReadingRate, isAutoReadingMode, type AutoReadingMode, type AutoReadingResult } from './auto-reading-modes';

export interface AutoReadingViewport {
  readonly flow?: 'scroll' | 'paginated';
  readonly advanceAutoScroll?: (pixels: number) => AutoReadingResult;
  readonly advanceAutoReading?: (mode: AutoReadingMode, amount: number) => AutoReadingResult;
  readonly resetAutoReading?: () => void;
}

const SPEED_KEY = 'moya.reader-auto-scroll-speed.v1';
const MODE_KEY = 'moya.reader-auto-scroll-mode.v1';
function savedMode(key: string): AutoReadingMode {
  try {
    const value = localStorage.getItem(key);
    return isAutoReadingMode(value) ? value : 'pixel';
  } catch {
    return 'pixel';
  }
}
function savedSpeed(key = SPEED_KEY, max = 12): number {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isInteger(value) && value >= 1 && value <= max ? value : 4;
  } catch {
    return 4;
  }
}

export function useAutoScroll(
  viewport: MutableRefObject<AutoReadingViewport | undefined>,
  scope: string,
  allowed: boolean,
  ready = true,
  nextChapter?: { scope: string; open: (isCurrent: () => boolean) => Promise<void> },
  kind: 'text' | 'comic' = 'text',
) {
  const [standardSpeed, setSpeedState] = useState(() => savedSpeed());
  const pixelSpeedKey = `moya.${kind}-auto-pixel-speed.v2`;
  const [pixelSpeed, setPixelSpeed] = useState(() => {
    try {
      if (localStorage.getItem(pixelSpeedKey) !== null) return savedSpeed(pixelSpeedKey, 240);
    } catch {
      /* Optional preference. */
    }
    return savedSpeed();
  });
  const modeKey = kind === 'text' ? MODE_KEY : 'moya.comic-auto-reading-mode.v1';
  const intervalKey = `moya.${kind}-auto-page-interval.v1`;
  const [mode, setModeState] = useState<AutoReadingMode>(() => savedMode(modeKey));
  const speed = mode === 'pixel' ? pixelSpeed : standardSpeed;
  const maxSpeed = mode === 'pixel' ? 240 : 12;
  const [interval, setIntervalState] = useState(() => {
    try {
      const value = Number(localStorage.getItem(intervalKey));
      if (Number.isInteger(value) && value >= 3 && value <= 120) return value;
    } catch {
      /* Optional preference. */
    }
    return kind === 'comic' ? 10 : 20;
  });
  const [continueChapter, setContinueChapter] = useState(false);
  const [started, setStarted] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const overlayKey = `moya.${kind}-auto-overlay.v1`;
  const [alwaysShowOverlay, setAlwaysShowOverlayState] = useState(() => {
    try {
      return localStorage.getItem(overlayKey) === 'true';
    } catch {
      return false;
    }
  });
  const setAlwaysShowOverlay = (value: boolean) => {
    setAlwaysShowOverlayState(value);
    try {
      localStorage.setItem(overlayKey, String(value));
    } catch {
      /* Optional preference. */
    }
  };
  const flow = viewport.current?.flow;
  const supportedModes =
    flow === 'paginated'
      ? kind === 'comic'
        ? ['page-turn']
        : ['page-turn', 'blind-pixel', 'blind-line']
      : kind === 'comic'
        ? ['pixel']
        : ['pixel', 'line', 'page', 'blind-pixel', 'blind-line', 'rsvp'];
  const modeAllowed = supportedModes.includes(mode);
  const running = allowed && modeAllowed && started;
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
      localStorage.setItem(modeKey, value);
    } catch {
      /* Optional browser preference. */
    }
  };
  const setInterval = (value: number) => {
    if (!Number.isInteger(value) || value < 3 || value > 120) return;
    setIntervalState(value);
    try {
      localStorage.setItem(intervalKey, String(value));
    } catch {
      /* Optional preference. */
    }
  };
  const setSpeed = (value: number) => {
    if (!Number.isInteger(value) || value < 1 || value > maxSpeed) return;
    if (mode === 'pixel') setPixelSpeed(value);
    else setSpeedState(value);
    try {
      localStorage.setItem(mode === 'pixel' ? pixelSpeedKey : SPEED_KEY, String(value));
    } catch {
      /* Browser storage is optional. */
    }
  };

  useEffect(() => {
    stop();
  }, [flow, stop]);

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
    let pageElapsed = 0;
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
        pageElapsed = 0;
        frame = requestAnimationFrame(tick);
        return;
      }
      if (mode.startsWith('blind-') && initializedBlindScope !== latest.current.scope) {
        const initialized = viewport.current?.advanceAutoReading?.(mode, 0);
        if (initialized === 'moving') initializedBlindScope = latest.current.scope;
      }
      if (mode === 'page-turn') {
        const status = viewport.current?.advanceAutoReading?.(mode, 0);
        if (!status || status === 'failed') {
          stop();
          return;
        }
        if (status === 'waiting') {
          pageElapsed = 0;
          endSince = undefined;
          frame = requestAnimationFrame(tick);
          return;
        }
        pageElapsed += elapsed;
        if (pageElapsed < interval * 1000 && endSince === undefined) {
          frame = requestAnimationFrame(tick);
          return;
        }
        pageElapsed = 0;
      }
      remainder += mode === 'page-turn' ? 1 : (elapsed * autoReadingRate(mode, speed)) / 1000;
      const pixels = Math.floor(remainder);
      remainder -= pixels;
      if (pixels > 0 || endSince !== undefined) {
        const result =
          mode === 'pixel'
            ? viewport.current?.advanceAutoScroll?.(pixels)
            : viewport.current?.advanceAutoReading?.(mode, pixels);
        if (!result || result === 'failed') {
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
  }, [running, speed, interval, mode, stop, viewport]);

  return {
    running,
    overlayVisible: running || (alwaysShowOverlay && hasStarted),
    alwaysShowOverlay,
    setAlwaysShowOverlay,
    modeAllowed,
    supportedModes,
    interval,
    setInterval,
    speed,
    maxSpeed,
    mode,
    setMode,
    continueChapter,
    setContinueChapter,
    setSpeed,
    stop,
    start: () => {
      if (allowed && modeAllowed && ready && !document.hidden) {
        owner.current = scope;
        setHasStarted(true);
        setStarted(true);
      }
    },
  };
}
