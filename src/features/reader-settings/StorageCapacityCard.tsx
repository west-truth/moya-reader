import { HardDrive, AlertCircle } from 'lucide-react';
import type { StorageCapacity } from '../../domain/types';
import { formatStorageBytes } from './DeviceStorageEstimate';

export function StorageCapacityCard({ capacity }: { capacity?: StorageCapacity }) {
  if (!capacity || capacity.status !== 'available')
    return (
      <div className="storage-capacity-unavailable">
        <HardDrive size={18} aria-hidden="true" />
        <div>
          <strong>서버 저장공간</strong>
          <span>
            {capacity?.status === 'unavailable' && capacity.reason === 'read_failed'
              ? '남은 공간을 확인하지 못했습니다.'
              : '이 저장소는 전체 용량 조회가 설정되지 않았습니다.'}
          </span>
        </div>
      </div>
    );
  const fraction = Math.min(1, Math.max(0, capacity.availableBytes / capacity.totalBytes));
  const low = capacity.availableBytes <= Math.max(capacity.minimumFreeBytes, capacity.totalBytes * 0.05);
  return (
    <div className="storage-capacity" data-low={low || undefined}>
      <div className="storage-capacity-remaining">
        <strong>{formatStorageBytes(capacity.availableBytes)}</strong>
        <span>사용 가능</span>
      </div>
      <div
        className="storage-capacity-meter"
        role="meter"
        aria-label="서버 저장공간 사용량"
        aria-valuemin={0}
        aria-valuemax={capacity.totalBytes}
        aria-valuenow={capacity.totalBytes - capacity.availableBytes}
        aria-valuetext={`${formatStorageBytes(capacity.availableBytes)} 남음 / 전체 ${formatStorageBytes(capacity.totalBytes)}`}
      >
        <span style={{ width: `${(1 - fraction) * 100}%` }} />
      </div>
      <div className="storage-capacity-caption">
        <span>다른 서비스와 공유</span>
        <span>전체 {formatStorageBytes(capacity.totalBytes)}</span>
      </div>
      {low && (
        <p className="storage-capacity-warning">
          <AlertCircle size={16} aria-hidden="true" />
          저장공간이 얼마 남지 않았습니다.
        </p>
      )}
    </div>
  );
}
