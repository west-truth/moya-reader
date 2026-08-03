import type { ReaderSettings } from '../../domain/types';

export type SettingsSaveStatus = 'idle' | 'pending' | 'saving' | 'failed';

export interface SettingsSaveScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

interface SettingsSaveWriterOptions {
  readonly delayMs: number;
  readonly write: (settings: ReaderSettings) => Promise<void>;
  readonly onCommitted: (settings: ReaderSettings) => void;
  readonly onError: (error: unknown, settings: ReaderSettings) => void;
  readonly onStatusChange?: (status: SettingsSaveStatus) => void;
  readonly scheduler?: SettingsSaveScheduler;
}

const defaultScheduler: SettingsSaveScheduler = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class SerializedSettingsSaveWriter {
  private readonly scheduler: SettingsSaveScheduler;
  private pending?: ReaderSettings;
  private timer?: unknown;
  private tail: Promise<void> = Promise.resolve();
  private outstandingWrites = 0;

  constructor(private readonly options: SettingsSaveWriterOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  schedule(settings: ReaderSettings): void {
    this.pending = settings;
    this.clearTimer();
    this.options.onStatusChange?.('pending');
    this.timer = this.scheduler.set(() => {
      this.timer = undefined;
      void this.enqueuePending();
    }, this.options.delayMs);
  }

  hasUncommitted(): boolean {
    return Boolean(this.pending || this.timer !== undefined || this.outstandingWrites > 0);
  }

  flush(): Promise<void> {
    this.clearTimer();
    void this.enqueuePending();
    return this.tail;
  }

  dispose(): Promise<void> {
    return this.flush();
  }

  private enqueuePending(): Promise<void> {
    const settings = this.pending;
    if (!settings) return this.tail;
    this.pending = undefined;
    this.outstandingWrites += 1;
    const write = this.tail.then(async () => {
      this.options.onStatusChange?.('saving');
      try {
        await this.options.write(settings);
        this.options.onCommitted(settings);
      } catch (error) {
        this.options.onStatusChange?.('failed');
        try {
          this.options.onError(error, settings);
        } catch {
          // Error reporting must not break later queued writes.
        }
      } finally {
        this.outstandingWrites -= 1;
        if (this.pending || this.timer !== undefined) this.options.onStatusChange?.('pending');
        else if (this.outstandingWrites > 0) this.options.onStatusChange?.('saving');
        else this.options.onStatusChange?.('idle');
      }
    });
    this.tail = write.catch(() => undefined);
    return this.tail;
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.scheduler.clear(this.timer);
    this.timer = undefined;
  }
}
