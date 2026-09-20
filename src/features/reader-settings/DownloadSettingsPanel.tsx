import { Download, HardDrive, Server } from 'lucide-react';
import { SourceDownloadRecovery } from '../external-sources/SourceDownloadRecovery';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';

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
            <h3>서버 수집</h3>
            <p>self-host 소스가 원문이나 이미지를 받아 Moya 책장에 저장합니다.</p>
          </div>
        </div>
        <p className="reader-settings-fact">
          소스별 요청 제한과 현재 다운로드 대기열을 따릅니다. Wi-Fi 여부는 서버가 휴대폰 연결 상태를 알 수 없어 강제하지
          않습니다.
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
      </section>
    </div>
  );
}
