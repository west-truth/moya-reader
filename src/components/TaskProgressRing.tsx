import { LoaderCircle } from 'lucide-react';
import './task-progress-ring.css';

export function TaskProgressRing({
  percent,
  label,
  detail,
  tone = 'transfer',
}: {
  readonly percent?: number;
  readonly label: string;
  readonly detail?: string;
  readonly tone?: 'transfer' | 'processing';
}) {
  const value =
    typeof percent === 'number' && Number.isFinite(percent)
      ? Math.max(0, Math.min(100, Math.floor(percent)))
      : undefined;
  const ring = (
    <span
      className={`task-progress-ring${value === undefined ? ' is-indeterminate' : ''}`}
      data-tone={tone}
      role="progressbar"
      aria-label={label}
      aria-valuemin={value === undefined ? undefined : 0}
      aria-valuemax={value === undefined ? undefined : 100}
      aria-valuenow={value}
      aria-valuetext={detail}
      aria-live="off"
    >
      {value === undefined ? (
        <LoaderCircle size={18} className="spin" aria-hidden="true" />
      ) : (
        <span className="task-progress-ring-value" aria-hidden="true">
          {value}%
        </span>
      )}
      <svg className="task-progress-ring-outline" viewBox="0 0 32 32" aria-hidden="true">
        <circle className="task-progress-ring-track" cx="16" cy="16" r="14" />
        {value !== undefined && (
          <circle
            className="task-progress-ring-fill"
            cx="16"
            cy="16"
            r="14"
            pathLength="100"
            strokeDasharray={`${value} 100`}
          />
        )}
      </svg>
    </span>
  );
  return ring;
}
