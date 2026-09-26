import type { TaskProgress } from '@noveldesk/contracts';
import { formatBytes, formatCount } from '../utils/format';

export function taskProgressPercent(progress?: TaskProgress): number | undefined {
  if (
    !progress ||
    progress.phase === 'finalizing' ||
    progress.completed === undefined ||
    !Number.isFinite(progress.completed) ||
    !Number.isFinite(progress.total) ||
    !(progress.total! > 0)
  )
    return undefined;
  return Math.max(0, Math.min(100, Math.floor((progress.completed / progress.total!) * 100)));
}

export function taskProgressDetail(progress?: TaskProgress): string | undefined {
  if (!progress || progress.completed === undefined) return undefined;
  const format = progress.unit === 'bytes' ? formatBytes : formatCount;
  const amount =
    progress.total && progress.total > 0
      ? `${format(progress.completed)} / ${format(progress.total)}`
      : format(progress.completed);
  return `${amount}${progress.unit === 'images' ? '장' : progress.unit === 'items' ? '개' : ''}`;
}

export function taskProgressLabel(progress: TaskProgress): string {
  return {
    preparing: '준비 중',
    uploading: '업로드 중',
    downloading: '받는 중',
    verifying: '확인 중',
    saving: '저장 중',
    finalizing: '마무리 중',
  }[progress.phase];
}
