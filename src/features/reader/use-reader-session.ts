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
  readonly chapterId: string;
  readonly onCommitted: (novelId: string, seconds: number, readAt: string) => void;
  readonly onFailed: (seconds: number) => void;
  readonly onDisplayChanged: (seconds: number) => void;
  readonly personalizationRepository?: ReaderPersonalizationRepository;
}

export class ReaderSessionTracker {
  private persistedSeconds = 0;
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
    const deltaSeconds = this.elapsedSeconds() - this.persistedSeconds;
    if (deltaSeconds < 1) return this.queue;
    this.persistedSeconds += deltaSeconds;
    const readAt = new Date(this.now()).toISOString();
    const target = this.target;
    const operationId = `reading_session_${this.operationNonce}_${this.persistedSeconds}`;
    const run = this.queue.then(async () => {
      let sessionRecorded = false;
      try {
        if (target.personalizationRepository) {
          const endedAt = this.now();
          await target.personalizationRepository.appendReadingSession(
            readingSessionEvent({
              bookId: target.novelId,
              mode: 'reading',
              startedAt: endedAt - deltaSeconds * 1000,
              endedAt,
              activeSeconds: deltaSeconds,
              operationId,
            }),
          );
          sessionRecorded = true;
        }
        if (aggregatePersistent && persistReadingTime) {
          await persistReadingTime.call(target.repository, target.novelId, deltaSeconds, readAt);
          target.onCommitted(target.novelId, deltaSeconds, readAt);
        }
      } catch {
        if (!sessionRecorded) {
          this.persistedSeconds = Math.max(0, this.persistedSeconds - deltaSeconds);
        }
        target.onFailed(deltaSeconds);
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export interface ReaderSessionOptions extends ReaderSessionTarget {
  readonly statsVisible: boolean;
}

export function useReaderSession(options: ReaderSessionOptions): { flush: () => Promise<void> } {
  const trackerRef = useRef<ReaderSessionTracker>();

  useEffect(() => {
    const tracker = new ReaderSessionTracker(
      {
        repository: options.repository,
        novelId: options.novelId,
        chapterId: options.chapterId,
        onCommitted: options.onCommitted,
        onFailed: options.onFailed,
        onDisplayChanged: options.onDisplayChanged,
        personalizationRepository: options.personalizationRepository,
      },
      Date.now(),
    );
    trackerRef.current = tracker;
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
      void tracker.flush();
    };
  }, [
    options.chapterId,
    options.novelId,
    options.onCommitted,
    options.onDisplayChanged,
    options.onFailed,
    options.repository,
    options.personalizationRepository,
  ]);

  useEffect(() => {
    if (!options.statsVisible) return;
    const publish = () => {
      const tracker = trackerRef.current;
      if (tracker) tracker.target.onDisplayChanged(tracker.elapsedSeconds());
    };
    publish();
    const displayTimer = window.setInterval(publish, SESSION_DISPLAY_INTERVAL_MS);
    return () => window.clearInterval(displayTimer);
  }, [options.chapterId, options.novelId, options.statsVisible]);

  const flush = useCallback(() => trackerRef.current?.flush() ?? Promise.resolve(), []);
  return { flush };
}
