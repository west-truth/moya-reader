import type { Novel } from '../../domain/types';
import { isFixedDocumentFormat } from '../../domain/book-format';
import { formatProgress } from '../../utils/format';

interface LibraryReadingProgressProps {
  novel: Pick<Novel, 'title' | 'format'>;
  progress: number;
  positionLabel: string;
  className: string;
}

export function LibraryReadingProgress({
  novel,
  progress: rawProgress,
  positionLabel,
  className,
}: LibraryReadingProgressProps) {
  const progress = Math.round(Math.min(1, Math.max(0, rawProgress)) * 100);
  const subject = isFixedDocumentFormat(novel.format) ? '문서' : '작품';

  return (
    <div
      className={className}
      role="progressbar"
      aria-label={`${novel.title} 전체 ${subject} 진행률`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
      aria-valuetext={`${positionLabel} · 전체 ${formatProgress(rawProgress)}`}
    >
      <span aria-hidden="true" style={{ width: `${progress}%` }} />
    </div>
  );
}
