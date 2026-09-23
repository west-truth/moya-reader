import { LoaderCircle } from 'lucide-react';
import './task-progress-ring.css';

export function TaskProgressRing({
  percent,
  label,
  detail,
  onOpen,
  expanded,
}: {
  readonly percent?: number;
  readonly label: string;
  readonly detail?: string;
  readonly onOpen?: () => void;
  readonly expanded?: boolean;
}) {
  const value =
    typeof percent === 'number' && Number.isFinite(percent)
      ? Math.max(0, Math.min(100, Math.floor(percent)))
      : undefined;
  const ring = (
    <span
      className={`task-progress-ring${value === undefined ? ' is-indeterminate' : ''}`}
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
  return onOpen ? (
    <button
      className="task-progress-action"
      type="button"
      aria-label={`${label} 상세 보기`}
      aria-expanded={expanded}
      onClick={onOpen}
    >
      {ring}
    </button>
  ) : (
    ring
  );
}
