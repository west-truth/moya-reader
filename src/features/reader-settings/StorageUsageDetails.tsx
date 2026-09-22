import { useEffect, useState } from 'react';
import type { LibraryStorageUsage, StorageUsageBreakdown } from '../../domain/types';
import { readSourceMetadataCacheUsage } from '../../external-sources/local-state';
import { formatStorageBytes } from './DeviceStorageEstimate';

const labels: Record<keyof StorageUsageBreakdown, string> = {
  document: '문서',
  image: '이미지',
  audio: '오디오',
  other: '기타',
};

function DeviceCacheUsage() {
  const [usage, setUsage] = useState<{ bytes: number; entries: number } | null>();
  useEffect(() => {
    let active = true;
    void readSourceMetadataCacheUsage().then(
      (next) => {
        if (active) setUsage(next);
      },
      () => {
        if (active) setUsage(null);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="storage-cache-detail">
      <div>
        <span>기기 목록 캐시</span>
        <strong>
          {usage === undefined ? '확인 중…' : usage === null ? '조회 불가' : formatStorageBytes(usage.bytes)}
        </strong>
      </div>
      <small>서버 용량에 포함되지 않는 기기 캐시 추정치입니다.</small>
    </div>
  );
}

export function StorageUsageDetails({ usage }: { usage: LibraryStorageUsage }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="storage-usage-details" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>사용량 상세</summary>
      <dl>
        {Object.entries(labels).map(([key, label]) => {
          const bytes = usage.breakdown?.[key as keyof StorageUsageBreakdown];
          return bytes === undefined ? null : (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{formatStorageBytes(bytes)}</dd>
            </div>
          );
        })}
      </dl>
      {!usage.breakdown && <p className="field-help">서버 업데이트 후 상세 용량을 확인할 수 있습니다.</p>}
      {Boolean(usage.unmeasuredAudioFiles) && (
        <p className="field-help">용량 기록이 없는 음성 {usage.unmeasuredAudioFiles}개는 제외됩니다.</p>
      )}
      <p className="field-help">공유 파일은 한 번만 집계합니다. DB·임시 파일·이전 버전은 제외됩니다.</p>
      {open && <DeviceCacheUsage />}
    </details>
  );
}
