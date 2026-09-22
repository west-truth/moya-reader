import { Download, HardDrive, Server } from 'lucide-react';
import { SourceDownloadRecovery } from '../external-sources/SourceDownloadRecovery';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';

export function DownloadSettingsPanel({ controller }: { readonly controller: ExternalSourceController }) {
  const autoDownload = controller.autoDownloadNext ?? false;
  const count = controller.autoDownloadNextCount ?? 1;
  const retention = controller.downloadRetention;
  return (
    <div className="reader-settings-destination-sections">
      <section className="settings-section-card">
        <div className="settings-section-heading">
          <Download size={18} aria-hidden="true" />
          <div>
            <h3>다음 회차 미리 받기</h3>
            <p>다음 회차를 미리 다운로드합니다.</p>
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

      {retention && (
        <section className="settings-section-card" aria-label="읽은 회차 정리">
          <div className="settings-section-heading">
            <HardDrive size={18} aria-hidden="true" />
            <div>
              <h3>읽은 회차 정리</h3>
              <p>설정한 회차 수만큼 더 읽으면 이전 다운로드를 정리합니다.</p>
            </div>
          </div>
          <label className="reader-settings-control-toggle">
            <span>
              <strong>리더를 나온 뒤 자동 정리</strong>
              <small>즐겨찾기는 유지합니다. 서버의 다운로드를 정리하면 모든 기기에 반영됩니다.</small>
            </span>
            <input
              type="checkbox"
              checked={retention.enabled}
              disabled={retention.busy}
              onChange={(e) => retention.setEnabled(e.target.checked)}
            />
          </label>
          <label className="reader-settings-select-row">
            <span>
              <strong>정리 전 더 읽을 회차 수</strong>
              <small>5회 설정: 1화를 읽은 뒤 이후 5개 회차도 읽었을 때 1화를 정리 대상으로 봅니다.</small>
            </span>
            <select
              aria-label="정리 전 더 읽을 회차 수"
              value={retention.keep}
              disabled={retention.busy}
              onChange={(e) => retention.setKeep(Number(e.target.value) as 5 | 10 | 20)}
            >
              <option value={5}>5회</option>
              <option value={10}>10회</option>
              <option value={20}>20회</option>
            </select>
          </label>
          <p className="field-help">
            이어볼 회차·미독 회차·즐겨찾기·가져온 파일은 보존합니다. 독서·다운로드 중에는 정리하지 않습니다. 삭제 후
            다시 받지 못할 수 있습니다.
          </p>
        </section>
      )}

      <section className="settings-section-card">
        <div className="settings-section-heading">
          <Server size={18} aria-hidden="true" />
          <div>
            <h3>회차 다운로드 대기열</h3>
          </div>
        </div>
        <p className="reader-settings-fact">서버에서 다운로드하므로 휴대폰의 Wi-Fi 설정은 적용되지 않습니다.</p>
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
        <p className="field-help">회차 대기열에 적용됩니다. 미리 받기·파일 가져오기는 제외됩니다.</p>
      </section>
    </div>
  );
}
