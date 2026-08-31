import type { StructuredLogger } from '../observability/logger.js';

type ImportPhase =
  | 'read_upload'
  | 'append_lock'
  | 'base_read_merge'
  | 'parse_archive'
  | 'write_source'
  | 'write_assets'
  | 'commit_database'
  | 'cleanup';

/** One bounded, content-free summary per claimed job, including partial failures. */
export class ImportMeasurements {
  readonly counts = {
    uploadBytes: 0,
    baseBytes: 0,
    canonicalBytes: 0,
    pageCount: 0,
    writtenPages: 0,
    writtenPageBytes: 0,
    reusedPages: 0,
    reusedPageBytes: 0,
    incrementalAppend: false,
  };
  private readonly phasesMs: Partial<Record<ImportPhase, number>> = {};
  private phase: ImportPhase = 'read_upload';
  private started: number;
  private readonly jobStarted: number;

  constructor(
    private readonly logger: Pick<StructuredLogger, 'info'> | undefined,
    private readonly jobId: string,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.started = this.jobStarted = now();
  }

  start(phase: ImportPhase): void {
    const end = this.now();
    this.phasesMs[this.phase] = (this.phasesMs[this.phase] ?? 0) + Math.max(0, end - this.started);
    this.phase = phase;
    this.started = end;
  }

  finish(outcome: 'committed' | 'noop' | 'not_committed'): void {
    this.start(this.phase);
    try {
      this.logger?.info('import_job_profile', {
        jobId: this.jobId,
        outcome,
        state: this.phase,
        durationMs: Math.round(this.now() - this.jobStarted),
        ...this.counts,
        phasesMs: Object.fromEntries(Object.entries(this.phasesMs).map(([key, value]) => [key, Math.round(value)])),
      });
    } catch {
      // Diagnostics must not change the import's commit/rollback outcome.
    }
  }
}
