import type { TTSSleepTimerPreset } from '../domain/types';

export class TTSActiveSleepTimer {
  private preset?: TTSSleepTimerPreset;
  private remainingMs?: number;
  private runningSince?: number;

  constructor(private readonly now: () => number = () => performance.now()) {}

  start(preset?: TTSSleepTimerPreset): void {
    this.preset = preset;
    this.remainingMs = typeof preset === 'number' ? preset * 60_000 : undefined;
    this.runningSince = this.remainingMs === undefined ? undefined : this.now();
  }

  pause(): void {
    this.tick();
    this.runningSince = undefined;
  }

  resume(): void {
    if (this.remainingMs !== undefined && this.runningSince === undefined) this.runningSince = this.now();
  }

  clear(): void {
    this.preset = undefined;
    this.remainingMs = undefined;
    this.runningSince = undefined;
  }

  shouldStopAfterItem(): boolean {
    this.tick();
    return this.remainingMs !== undefined && this.remainingMs <= 0;
  }

  shouldStopAtChapterEnd(): boolean {
    return this.preset === 'end_of_chapter' || this.shouldStopAfterItem();
  }

  get remainingSeconds(): number | undefined {
    this.tick();
    return this.remainingMs === undefined ? undefined : Math.max(0, Math.ceil(this.remainingMs / 1_000));
  }

  get activePreset(): TTSSleepTimerPreset | undefined {
    return this.preset;
  }

  private tick(): void {
    if (this.remainingMs === undefined || this.runningSince === undefined) return;
    const now = this.now();
    this.remainingMs = Math.max(0, this.remainingMs - Math.max(0, now - this.runningSince));
    this.runningSince = now;
  }
}
