import { RefreshCw } from 'lucide-react';

export function DiscoveryHeading({
  title,
  eyebrow,
  loading = false,
  failed = false,
  updated = false,
  refresh,
}: {
  title: string;
  eyebrow?: string;
  loading?: boolean;
  failed?: boolean;
  updated?: boolean;
  refresh?: () => void;
}) {
  const action = loading
    ? '목록 불러오는 중'
    : failed
      ? '목록 다시 불러오기'
      : updated
        ? '새 목록 보기'
        : '목록 새로고침';
  return (
    <div className="discovery-section-heading">
      {eyebrow && <small>{eyebrow}</small>}
      <div className="discovery-section-title">
        <h2>{title}</h2>
        {refresh && (
          <button
            type="button"
            className="icon-btn discovery-refresh"
            aria-label={`${title} ${action}`}
            title={failed ? '목록을 갱신하지 못했습니다. 다시 불러오기' : action}
            disabled={loading}
            aria-busy={loading}
            data-pending={failed || updated || undefined}
            onClick={refresh}
          >
            <RefreshCw size={18} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
