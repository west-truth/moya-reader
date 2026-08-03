import type { Novel } from '../../domain/types';
import { formatProgress } from '../../utils/format';

interface LibraryReadingProgressProps {
  novel: Pick<Novel, 'title' | 'lastReadProgress'>;
  className: string;
}

export function LibraryReadingProgress({ novel, className }: LibraryReadingProgressProps) {
  const progress = Math.round(Math.min(1, Math.max(0, novel.lastReadProgress)) * 100);

  return (
    <div
      className={className}
      role="progressbar"
      aria-label={`${novel.title} 읽기 진행률`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
      aria-valuetext={formatProgress(novel.lastReadProgress)}
    >
      <span aria-hidden="true" style={{ width: `${progress}%` }} />
    </div>
  );
}
