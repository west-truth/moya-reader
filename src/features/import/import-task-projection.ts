import type { TaskProgress } from '@noveldesk/contracts';
import { taskProgressDetail } from '../../components/task-progress';
import type { ImportProgress } from '../../services/import/import-service';

export type ImportTaskPhase =
  | 'queued'
  | 'preparing'
  | 'downloading'
  | 'downloaded'
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
  readonly activity?: string;
  readonly measurement?: TaskProgress;
  readonly finalizing?: boolean;
}

function boundedPercent(completed: number, total: number): number | undefined {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.floor((completed / total) * 100)));
}

function projectImportPhase(progress: ImportProgress): Pick<ImportTaskView, 'phase' | 'percent'> {
  if (progress.status === 'failed') return { phase: 'failed' };
  if (progress.status === 'cancelling') return { phase: 'cancelling' };
  if (progress.status === 'ready' || progress.subphase === 'complete') return { phase: 'saving' };
  if (progress.status === 'writing' && progress.progressUnit === 'images') {
    return { phase: 'saving', percent: boundedPercent(progress.completedUnits ?? 0, progress.totalUnits ?? 0) };
  }

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
    return { phase: 'preparing', percent: boundedPercent(progress.bytesRead, progress.totalBytes) };
  }
  if (progress.status === 'reading') return { phase: 'preparing' };
  return { phase: 'queued' };
}

export function projectImportProgress(
  progress: ImportProgress,
): Pick<ImportTaskView, 'phase' | 'percent' | 'activity' | 'measurement' | 'finalizing'> {
  const phase = projectImportPhase(progress);
  const message = progress.message?.trim();
  // Keep card/release labels compact; older servers can still send long descriptions.
  const activity =
    progress.subphase === 'server_processing' &&
    ['reading', 'decoding', 'splitting_chapters', 'writing'].includes(progress.status) &&
    message &&
    message.length <= 48 &&
    !/[\r\n<>]/u.test(message)
      ? message
      : undefined;
  const measurement: TaskProgress | undefined =
    phase.percent === undefined
      ? undefined
      : {
          phase: phase.phase === 'uploading' ? 'uploading' : phase.phase === 'saving' ? 'saving' : 'preparing',
          completed: progress.progressUnit === 'images' ? progress.completedUnits : progress.bytesRead,
          total: progress.progressUnit === 'images' ? progress.totalUnits : progress.totalBytes,
          unit: progress.progressUnit === 'images' ? 'images' : 'bytes',
        };
  return {
    ...phase,
    activity,
    measurement,
    finalizing:
      progress.status === 'ready' ||
      progress.subphase === 'complete' ||
      (progress.status === 'writing' && activity === '마무리 중'),
  };
}

export function importTaskLabel(task: ImportTaskView): string {
  if (task.activity && ['preparing', 'analyzing', 'saving'].includes(task.phase))
    return task.activity.replace(/^파일 준비 /u, '준비 ').replace(/^이미지 저장 /u, '저장 ');
  switch (task.phase) {
    case 'queued':
      return '대기 중';
    case 'preparing':
      return task.percent === undefined ? '준비 중' : `준비 ${task.percent}%`;
    case 'downloading':
      return '다운로드 중';
    case 'downloaded':
      return '저장 대기';
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

export function importTaskStageLabel(task: ImportTaskView): string {
  if (task.phase === 'saving' && task.finalizing) return '마무리 중';
  return importTaskLabel({ ...task, activity: undefined, percent: undefined });
}
export function importTaskDetail(task: ImportTaskView): string | undefined {
  return taskProgressDetail(task.measurement) ?? task.activity;
}
export function importTaskTone(task: ImportTaskView): 'transfer' | 'processing' {
  return ['uploading', 'downloading', 'queued'].includes(task.phase) ? 'transfer' : 'processing';
}
