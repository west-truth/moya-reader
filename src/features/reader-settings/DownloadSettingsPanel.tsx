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
          <div className="installed-extension-actions">
            <button type="button" disabled={retention.busy || controller.busy} onClick={() => void retention.inspect()}>
              {retention.busy ? '처리 중…' : '정리 대상 미리보기'}
            </button>
            {Boolean(retention.preview?.length) && (
              <button
                type="button"
                disabled={retention.busy || controller.busy || retention.readerActive}
                onClick={() => void retention.clean()}
              >
                확인 후 지금 정리
              </button>
            )}
          </div>
          {retention.preview && (
            <div role="status">
              {retention.preview.length ? (
                <>
                  <p>
                    {retention.preview.length}개 작품 · {retention.preview.reduce((n, p) => n + p.sections.length, 0)}회
                    정리 가능
                  </p>
                  <details>
                    <summary>작품별 대상 보기</summary>
                    <ul>
                      {retention.preview.map((p) => (
                        <li key={p.bookId}>
                          {p.title} · {p.sections.length}회
                        </li>
                      ))}
                    </ul>
                  </details>
                </>
              ) : (
                <p>지금 정리할 회차가 없습니다.</p>
              )}
            </div>
          )}
          {retention.error && <p role="alert">{retention.error}</p>}
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

      <section className="settings-section-card">
        <div className="settings-section-heading">
          <HardDrive size={18} aria-hidden="true" />
          <div>
            <h3>이 기기와 파일 저장</h3>
            <p>서버와 별도로 이 기기에 저장한 데이터입니다.</p>
          </div>
        </div>
        <DeviceStorageEstimate />
      </section>
    </div>
  );
}
