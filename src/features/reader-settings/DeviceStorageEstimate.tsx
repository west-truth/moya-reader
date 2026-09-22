import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

interface StorageEstimateView {
  readonly usage?: number;
  readonly quota?: number;
  readonly loading: boolean;
  readonly unavailable: boolean;
}

export function formatStorageBytes(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

export function DeviceStorageEstimate() {
  const [estimate, setEstimate] = useState<StorageEstimateView>({ loading: true, unavailable: false });
  const refresh = useCallback(async () => {
    const read = globalThis.navigator?.storage?.estimate;
    if (!read) {
      setEstimate({ loading: false, unavailable: true });
      return;
    }
    setEstimate((current) => ({ ...current, loading: true }));
    try {
      const next = await read.call(globalThis.navigator.storage);
      setEstimate({ usage: next.usage, quota: next.quota, loading: false, unavailable: false });
    } catch {
      setEstimate({ loading: false, unavailable: true });
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const ratio =
    estimate.usage !== undefined && estimate.quota
      ? Math.min(100, Math.max(0, (estimate.usage / estimate.quota) * 100))
      : undefined;
  return (
    <div className="download-storage-estimate" aria-live="polite">
      <div>
        <strong>이 브라우저의 사이트 저장공간</strong>
        <span>
          {estimate.loading
            ? '확인 중…'
            : estimate.unavailable
              ? '이 브라우저에서는 사용량을 확인할 수 없습니다.'
              : `${formatStorageBytes(estimate.usage)} / ${formatStorageBytes(estimate.quota)}`}
        </span>
      </div>
      {ratio !== undefined && (
        <div
          className="download-storage-meter"
          role="meter"
          aria-label="브라우저 저장공간 사용률"
          aria-valuenow={ratio}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${ratio}%` }} />
        </div>
      )}
      <button type="button" className="ghost-btn" onClick={() => void refresh()} disabled={estimate.loading}>
        <RefreshCw size={15} aria-hidden="true" />
        다시 확인
      </button>
      <small>기기 데이터와 캐시의 추정치입니다. 서버 책장 용량은 포함하지 않습니다.</small>
    </div>
  );
}
