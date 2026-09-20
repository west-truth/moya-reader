import { useCallback, useEffect, useState } from 'react';
import { Download, HardDrive, RefreshCw, Server } from 'lucide-react';
import { SourceDownloadRecovery } from '../external-sources/SourceDownloadRecovery';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';

interface StorageEstimateView {
  readonly usage?: number;
  readonly quota?: number;
  readonly loading: boolean;
  readonly unavailable: boolean;
}

function formatStorageBytes(value?: number): string {
  if (!value || value < 1) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function DeviceStorageEstimate() {
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
      <button type="button" onClick={() => void refresh()} disabled={estimate.loading}>
        <RefreshCw size={15} aria-hidden="true" />
        다시 확인
      </button>
      <small>
        Moya의 기기 설정·오프라인 데이터와 브라우저 캐시를 합친 추정치입니다. 서버 책장 용량은 포함하지 않습니다.
      </small>
    </div>
  );
}

export function DownloadSettingsPanel({ controller }: { readonly controller: ExternalSourceController }) {
  const autoDownload = controller.autoDownloadNext ?? false;
  const count = controller.autoDownloadNextCount ?? 1;
  return (
    <div className="reader-settings-destination-sections">
      <section className="settings-section-card">
        <div className="settings-section-heading">
          <Download size={18} aria-hidden="true" />
          <div>
            <h3>다음 회차 미리 받기</h3>
            <p>읽고 있는 작품과 연결된 콘텐츠 소스에서 다음 회차를 책장으로 가져옵니다.</p>
          </div>
        </div>
        <label className="reader-settings-control-toggle">
          <span>
            <strong>자동으로 다음 회차 받기</strong>
            <small>한 회차를 읽기 시작할 때 한 번만 확인하며 연속 다운로드를 만들지 않습니다.</small>
          </span>
          <input
            type="checkbox"
            checked={autoDownload}
            disabled={!controller.setAutoDownloadNext}
            onChange={(event) => controller.setAutoDownloadNext?.(event.target.checked)}
          />
        </label>
        <label className="reader-settings-select-row">
          <span>
            <strong>미리 받을 회차 수</strong>
            <small>현재 회차 다음부터 선택한 수만큼 확인합니다.</small>
          </span>
          <select
            value={count}
            disabled={!autoDownload || !controller.setAutoDownloadNextCount}
            onChange={(event) => controller.setAutoDownloadNextCount?.(Number(event.target.value) as 1 | 2 | 3)}
          >
            <option value={1}>1회</option>
            <option value={2}>2회</option>
            <option value={3}>3회</option>
          </select>
        </label>
      </section>

      <SourceDownloadRecovery controller={controller} />

      <section className="settings-section-card">
        <div className="settings-section-heading">
          <Server size={18} aria-hidden="true" />
          <div>
            <h3>회차 다운로드 대기열</h3>
            <p>self-host 소스가 원문이나 이미지를 받아 Moya 책장에 저장합니다.</p>
          </div>
        </div>
        <p className="reader-settings-fact">
          소스별 요청 제한과 현재 다운로드 대기열을 따릅니다. Wi-Fi 여부는 서버가 휴대폰 연결 상태를 알 수 없어 강제하지
          않습니다.
        </p>
        <dl className="download-policy-facts">
          <div>
            <dt>동시에 받기</dt>
            <dd>소스가 허용한 범위에서 최대 2회</dd>
          </div>
          <div>
            <dt>작업 순서</dt>
            <dd>회차 순서를 보존하고 실패한 항목에서 멈춤</dd>
          </div>
          <div>
            <dt>브라우저 종료</dt>
            <dd>저장된 대기열은 다음 접속에서 복구 가능. 서버에서 진행 중인 요청은 즉시 취소되지 않을 수 있음</dd>
          </div>
        </dl>
        <p className="field-help">
          이 정책은 회차 대기열에 적용됩니다. 자동 미리 받기와 개별 파일 가져오기는 별도 작업입니다.
        </p>
      </section>

      <section className="settings-section-card">
        <div className="settings-section-heading">
          <HardDrive size={18} aria-hidden="true" />
          <div>
            <h3>이 기기와 파일 저장</h3>
            <p>브라우저 오프라인 저장과 파일 내보내기는 서버 책장 저장과 별개입니다.</p>
          </div>
        </div>
        <p className="reader-settings-fact">
          현재 플랫폼이 제공하는 저장 위치만 사용할 수 있습니다. 서버의 임의 경로나 지원하지 않는 CBZ 저장 옵션은
          노출하지 않습니다.
        </p>
        <DeviceStorageEstimate />
      </section>
    </div>
  );
}
