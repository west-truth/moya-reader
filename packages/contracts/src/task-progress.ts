/** A measured phase of one running request, never an estimate of whole-job completion. */
export interface TaskProgress {
  readonly phase: 'preparing' | 'uploading' | 'downloading' | 'verifying' | 'saving' | 'finalizing';
  readonly completed?: number;
  readonly total?: number;
  readonly unit?: 'bytes' | 'images' | 'items';
}
export type TaskProgressCallback = (progress: TaskProgress) => void;
