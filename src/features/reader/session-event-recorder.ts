import type { ReadingSessionEvent, ReadingSessionMode } from '../../domain/types';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';

const DEVICE_ID_KEY = 'noveldesk.readingDeviceId.v1';

export function readingDeviceId(): string {
  try {
    const stored = globalThis.localStorage?.getItem(DEVICE_ID_KEY)?.trim();
    if (stored) return stored;
    const id = `device_${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
    globalThis.localStorage?.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return 'device_local';
  }
}

function eventId(mode: ReadingSessionMode): string {
  return `${mode}_session_${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}

export function readingSessionEvent(input: {
  readonly bookId: string;
  readonly mode: ReadingSessionMode;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly activeSeconds: number;
  readonly operationId?: string;
}): ReadingSessionEvent {
  const id = input.operationId ?? eventId(input.mode);
  return {
    id,
    operationId: id,
    deviceId: readingDeviceId(),
    bookId: input.bookId,
    mode: input.mode,
    startedAt: new Date(input.startedAt).toISOString(),
    endedAt: new Date(input.endedAt).toISOString(),
    activeSeconds: input.activeSeconds,
  };
}

export class ActiveIntervalSessionRecorder {
  private activeSince?: number;
  private accumulatedMs = 0;
  private intervalStartedAt?: number;
  private queue = Promise.resolve();

  constructor(
    private readonly repository: ReaderPersonalizationRepository,
    private readonly bookId: string,
    private readonly mode: ReadingSessionMode,
    private readonly now: () => number = () => Date.now(),
  ) {}

  setActive(active: boolean): void {
    const now = this.now();
    if (active && this.activeSince === undefined) {
      this.activeSince = now;
      this.intervalStartedAt ??= now;
    } else if (!active && this.activeSince !== undefined) {
      this.accumulatedMs += Math.max(0, now - this.activeSince);
      this.activeSince = undefined;
    }
  }

  activeSeconds(): number {
    const running = this.activeSince === undefined ? 0 : Math.max(0, this.now() - this.activeSince);
    return Math.floor((this.accumulatedMs + running) / 1000);
  }

  flush(): Promise<void> {
    const now = this.now();
    if (this.activeSince !== undefined) {
      this.accumulatedMs += Math.max(0, now - this.activeSince);
      this.activeSince = now;
    }
    const seconds = Math.floor(this.accumulatedMs / 1000);
    if (seconds < 1) return this.queue;
    const consumedMs = seconds * 1000;
    const startedAt = this.intervalStartedAt ?? now - consumedMs;
    this.accumulatedMs -= consumedMs;
    this.intervalStartedAt =
      this.activeSince === undefined && this.accumulatedMs === 0 ? undefined : now - this.accumulatedMs;
    const event = readingSessionEvent({
      bookId: this.bookId,
      mode: this.mode,
      startedAt,
      endedAt: now,
      activeSeconds: seconds,
    });
    const run = this.queue
      .then(() => this.repository.appendReadingSession(event))
      .catch((error: unknown) => {
        this.accumulatedMs += consumedMs;
        this.intervalStartedAt = Math.min(this.intervalStartedAt ?? startedAt, startedAt);
        throw error;
      });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
