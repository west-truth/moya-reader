export interface AnimationFrameScheduler {
  readonly request: (callback: FrameRequestCallback) => number;
  readonly cancel: (handle: number) => void;
}

export class RafProgressPublisher<T> {
  private frame?: number;
  private pending?: T;

  constructor(
    private readonly scheduler: AnimationFrameScheduler,
    private readonly publish: (value: T) => void,
  ) {}

  schedule(value: T): void {
    this.pending = value;
    if (this.frame !== undefined) return;
    this.frame = this.scheduler.request(() => {
      this.frame = undefined;
      const pending = this.pending;
      this.pending = undefined;
      if (pending !== undefined) this.publish(pending);
    });
  }

  cancel(): void {
    if (this.frame !== undefined) this.scheduler.cancel(this.frame);
    this.frame = undefined;
    this.pending = undefined;
  }
}

export class SerializedProgressPersistence {
  private queue = Promise.resolve();

  enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  settled(): Promise<void> {
    return this.queue;
  }
}

export interface ProgressPersistenceTimer {
  readonly set: (callback: () => void, delayMs: number) => number;
  readonly clear: (handle: number) => void;
}

/**
 * Keeps only the newest not-yet-started position while preserving write order.
 * `flush` is intentionally awaitable so navigation and app lifecycle boundaries
 * can commit the last debounced position before the reader disappears.
 */
export class DebouncedProgressPersistence<T> {
  private readonly persistence = new SerializedProgressPersistence();
  private pending?: T;
  private hasPending = false;
  private timerHandle?: number;

  constructor(
    private readonly timer: ProgressPersistenceTimer,
    private readonly delayMs: number,
    private readonly persist: (value: T) => Promise<void>,
  ) {}

  schedule(value: T): void {
    this.pending = value;
    this.hasPending = true;
    if (this.timerHandle !== undefined) this.timer.clear(this.timerHandle);
    this.timerHandle = this.timer.set(() => {
      this.timerHandle = undefined;
      void this.flush();
    }, this.delayMs);
  }

  flush(): Promise<void> {
    if (this.timerHandle !== undefined) this.timer.clear(this.timerHandle);
    this.timerHandle = undefined;
    if (!this.hasPending) return this.persistence.settled();
    const pending = this.pending as T;
    this.pending = undefined;
    this.hasPending = false;
    return this.persistence.enqueue(() => this.persist(pending));
  }

  /**
   * Skips the debounce delay while preserving write order. Starting a newer
   * write beside an older in-flight write can let the stale write finish last
   * and replace the lifecycle snapshot we are trying to preserve.
   */
  flushImmediately(): Promise<void> {
    if (this.timerHandle !== undefined) this.timer.clear(this.timerHandle);
    this.timerHandle = undefined;
    if (!this.hasPending) return this.persistence.settled();
    const pending = this.pending as T;
    this.pending = undefined;
    this.hasPending = false;
    return this.persistence.enqueue(() => this.persist(pending));
  }
}
