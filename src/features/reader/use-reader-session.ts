import { useCallback, useEffect, useRef } from 'react';
import type { ReaderRepository } from '../../repositories/reader-repository';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import { readingSessionEvent } from './session-event-recorder';

const SESSION_PERSIST_INTERVAL_MS = 30_000;
const SESSION_DISPLAY_INTERVAL_MS = 1_000;
const SESSION_IDLE_MS = 5 * 60_000;

export interface ReaderSessionTarget {
  readonly repository: Pick<ReaderRepository, 'addNovelReadingTime' | 'capabilities'>;
  readonly novelId: string;
  /** Retained for callers that still identify the opening chapter. Session lifetime is book-scoped. */
  readonly chapterId?: string;
  readonly onCommitted: (novelId: string, seconds: number, readAt: string, currentSession?: boolean) => void;
  readonly onFailed: (seconds: number) => void;
  readonly onDisplayChanged: (seconds: number) => void;
  readonly personalizationRepository?: ReaderPersonalizationRepository;
}

export class ReaderSessionTracker {
  private sessionPersistedSeconds = 0;
  private aggregatePersistedSeconds = 0;
  private pendingSession?: {
    readonly seconds: number;
    readonly event: ReturnType<typeof readingSessionEvent>;
  };
  private queue = Promise.resolve();
  private accumulatedMs = 0;
  private activeSince: number | undefined;
  private visible = true;
  private focused = true;
  private lastInteraction: number;
  private readonly operationNonce = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

  constructor(
    readonly target: ReaderSessionTarget,
    private readonly startedAt: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.lastInteraction = startedAt;
    this.activeSince = startedAt;
  }

  elapsedSeconds(): number {
    const now = this.now();
    const running = this.activeSince === undefined ? 0 : Math.max(0, now - this.activeSince);
    return Math.max(0, Math.floor((this.accumulatedMs + running) / 1000));
  }

  interact(): void {
    this.syncActiveState();
    this.lastInteraction = this.now();
    this.syncActiveState();
  }

  setEnvironment(visible: boolean, focused: boolean): void {
    this.visible = visible;
    this.focused = focused;
    this.syncActiveState();
  }

  checkIdle(): void {
    this.syncActiveState();
  }

  private syncActiveState(): void {
    const now = this.now();
    const shouldBeActive = this.visible && this.focused && now - this.lastInteraction < SESSION_IDLE_MS;
    if (shouldBeActive && this.activeSince === undefined) this.activeSince = now;
    if (!shouldBeActive && this.activeSince !== undefined) {
      const activeUntil = Math.min(now, this.lastInteraction + SESSION_IDLE_MS);
      this.accumulatedMs += Math.max(0, activeUntil - this.activeSince);
      this.activeSince = undefined;
    }
  }

  flush(): Promise<void> {
    this.checkIdle();
    const persistReadingTime = this.target.repository.addNovelReadingTime;
    const aggregatePersistent =
      this.target.repository.capabilities.readingTimePersistence === 'persistent' && Boolean(persistReadingTime);
    if (!aggregatePersistent && !this.target.personalizationRepository) {
      return this.queue;
    }
    const target = this.target;
    const run = this.queue.then(async () => {
      this.checkIdle();
      const elapsedSeconds = this.elapsedSeconds();
      let failedSeconds = 0;
      try {
        if (target.personalizationRepository) {
          while (this.pendingSession || elapsedSeconds - this.sessionPersistedSeconds > 0) {
            if (!this.pendingSession) {
              const seconds = elapsedSeconds - this.sessionPersistedSeconds;
              const endedAt = this.now();
              this.pendingSession = {
                seconds,
                event: readingSessionEvent({
                  bookId: target.novelId,
                  mode: 'reading',
                  startedAt: endedAt - seconds * 1000,
                  endedAt,
                  activeSeconds: seconds,
                  operationId: `reading_session_${this.operationNonce}_${this.sessionPersistedSeconds + seconds}`,
                }),
              };
            }
            const pendingSession = this.pendingSession;
            failedSeconds = pendingSession.seconds;
            await target.personalizationRepository.appendReadingSession(pendingSession.event);
            this.sessionPersistedSeconds += pendingSession.seconds;
            this.pendingSession = undefined;
            if (!aggregatePersistent) {
              target.onCommitted(target.novelId, pendingSession.seconds, pendingSession.event.endedAt);
            }
          }
        }
        const aggregateDeltaSeconds = aggregatePersistent ? elapsedSeconds - this.aggregatePersistedSeconds : 0;
        if (aggregatePersistent && persistReadingTime && aggregateDeltaSeconds > 0) {
          failedSeconds = aggregateDeltaSeconds;
          const readAt = new Date(this.now()).toISOString();
          await persistReadingTime.call(target.repository, target.novelId, aggregateDeltaSeconds, readAt);
          this.aggregatePersistedSeconds += aggregateDeltaSeconds;
          target.onCommitted(target.novelId, aggregateDeltaSeconds, readAt);
        }
      } catch {
        target.onFailed(failedSeconds);
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export interface ReaderSessionOptions extends Omit<ReaderSessionTarget, 'novelId'> {
  readonly active: boolean;
  readonly novelId?: string;
  readonly statsVisible: boolean;
  readonly onStarted?: () => void;
}

export function useReaderSession(options: ReaderSessionOptions): { flush: () => Promise<void> } {
  const trackerRef = useRef<ReaderSessionTracker>();
  const activeSessionRef = useRef<object>();
  const {
    active,
    novelId,
    onCommitted,
    onDisplayChanged,
    onFailed,
    onStarted,
    personalizationRepository,
    repository,
    statsVisible,
  } = options;

  useEffect(() => {
    if (!active || !novelId) {
      trackerRef.current = undefined;
      activeSessionRef.current = undefined;
      return;
    }
    const sessionIdentity = {};
    activeSessionRef.current = sessionIdentity;
    const tracker = new ReaderSessionTracker(
      {
        repository,
        novelId,
        onCommitted: (committedNovelId, seconds, readAt) =>
          onCommitted(committedNovelId, seconds, readAt, activeSessionRef.current === sessionIdentity),
        onFailed,
        onDisplayChanged,
        personalizationRepository,
      },
      Date.now(),
    );
    trackerRef.current = tracker;
    onStarted?.();
    tracker.target.onDisplayChanged(0);
    const visible = () => document.visibilityState !== 'hidden';
    let focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    tracker.setEnvironment(visible(), focused);
    const interact = () => tracker.interact();
    const visibilityChanged = () => {
      tracker.setEnvironment(visible(), focused);
      if (!visible()) void tracker.flush();
    };
    const focusedChanged = () => {
      focused = true;
      tracker.setEnvironment(visible(), focused);
      tracker.interact();
    };
    const blurred = () => {
      focused = false;
      tracker.setEnvironment(visible(), focused);
      void tracker.flush();
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('focus', focusedChanged);
    window.addEventListener('blur', blurred);
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
      window.addEventListener(type, interact, { passive: true });
    }
    const persistTimer = window.setInterval(() => void tracker.flush(), SESSION_PERSIST_INTERVAL_MS);
    return () => {
      window.clearInterval(persistTimer);
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('focus', focusedChanged);
      window.removeEventListener('blur', blurred);
      for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
        window.removeEventListener(type, interact);
      }
      if (trackerRef.current === tracker) trackerRef.current = undefined;
      if (activeSessionRef.current === sessionIdentity) activeSessionRef.current = undefined;
      void tracker.flush();
    };
  }, [active, novelId, onCommitted, onDisplayChanged, onFailed, onStarted, repository, personalizationRepository]);

  useEffect(() => {
    if (!statsVisible) return;
    const publish = () => {
      const tracker = trackerRef.current;
      if (tracker) tracker.target.onDisplayChanged(tracker.elapsedSeconds());
    };
    publish();
    const displayTimer = window.setInterval(publish, SESSION_DISPLAY_INTERVAL_MS);
    return () => window.clearInterval(displayTimer);
  }, [active, novelId, statsVisible]);

  const flush = useCallback(() => trackerRef.current?.flush() ?? Promise.resolve(), []);
  return { flush };
}
