import type { ImportProgress } from '../../services/import/import-service';

export type ImportTaskPhase =
  | 'queued'
  | 'preparing'
  | 'downloading'
  | 'verifying'
  | 'uploading'
  | 'analyzing'
  | 'saving'
  | 'complete'
  | 'cancelling'
  | 'failed';

export interface ImportTaskView {
  readonly id: string;
  readonly batchId: string;
  readonly source: 'local_file' | 'external_source';
  readonly title: string;
  readonly fileName?: string;
  readonly targetBookId?: string;
  readonly externalWorkId?: string;
  readonly externalItemKey?: string;
  readonly phase: ImportTaskPhase;
  readonly current?: number;
  readonly total?: number;
  readonly percent?: number;
  readonly error?: string;
}

function boundedPercent(completed: number, total: number): number | undefined {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
}

export function projectImportProgress(progress: ImportProgress): Pick<ImportTaskView, 'phase' | 'percent'> {
  if (progress.status === 'failed') return { phase: 'failed' };
  if (progress.status === 'cancelling') return { phase: 'cancelling' };
  if (progress.status === 'ready' || progress.subphase === 'complete') return { phase: 'saving', percent: 100 };

  if (progress.subphase === 'uploading_chunks') {
    return { phase: 'uploading', percent: boundedPercent(progress.bytesRead, progress.totalBytes) };
  }
  if (progress.subphase === 'hashing_source' || progress.subphase === 'reading_chunks') {
    return { phase: 'preparing', percent: boundedPercent(progress.bytesRead, progress.totalBytes) };
  }
  if (progress.status === 'decoding' || progress.status === 'splitting_chapters') {
    return { phase: 'analyzing' };
  }
  if (progress.status === 'writing') return { phase: 'saving' };
  if (progress.status === 'reading' && progress.subphase === 'server_processing') {
    return { phase: 'analyzing' };
  }
  if (progress.status === 'reading') return { phase: 'preparing' };
  return { phase: 'queued' };
}

export function importTaskLabel(task: ImportTaskView): string {
  switch (task.phase) {
    case 'queued':
      return '대기 중';
    case 'preparing':
      return task.percent === undefined ? '준비 중' : `준비 ${task.percent}%`;
    case 'downloading':
      return '다운로드 중';
    case 'verifying':
      return task.percent === undefined ? '확인 중' : `확인 ${task.percent}%`;
    case 'uploading':
      return task.percent === undefined ? '업로드 중' : `업로드 ${task.percent}%`;
    case 'analyzing':
      return '분석 중';
    case 'saving':
      return '저장 중';
    case 'complete':
      return '완료';
    case 'cancelling':
      return '취소 중';
    case 'failed':
      return '실패';
  }
}

export function importTaskIsActive(task: ImportTaskView): boolean {
  return task.phase !== 'failed' && task.phase !== 'complete';
}
