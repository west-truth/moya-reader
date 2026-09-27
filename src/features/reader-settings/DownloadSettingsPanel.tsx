import { useState } from 'react';
import {
  sourceReadingPreferences,
  saveSourceReadingPreferences,
  type SourceReadingPreferences,
} from '../../external-sources/source-reading-preferences';
import { Download, HardDrive, Server } from 'lucide-react';
import { SourceDownloadRecovery } from '../external-sources/SourceDownloadRecovery';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';

export function DownloadSettingsPanel({ controller }: { readonly controller: ExternalSourceController }) {
  const [sourceReading, setSourceReading] = useState(sourceReadingPreferences);
  const [cacheError, setCacheError] = useState('');
  const changeSourceReading = (patch: Partial<SourceReadingPreferences>) => {
    try {
      saveSourceReadingPreferences(patch);
      setSourceReading(sourceReadingPreferences());
      setCacheError('');
    } catch {
      setCacheError('설정을 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.');
    }
  };
  const autoDownload = controller.autoDownloadNext ?? false;
  const count = controller.autoDownloadNextCount ?? 1;
  const retention = controller.downloadRetention;
  return (
    <div className="reader-settings-destination-sections">
      <section className="settings-section-card" aria-label="소스 읽기와 캐시">
        <div className="settings-section-heading">
          <Download size={18} aria-hidden="true" />
          <div>
            <h3>소스 읽기와 캐시</h3>
            <p>이 브라우저에 적용됩니다. 저장한 회차는 캐시 설정과 관계없이 유지됩니다.</p>
          </div>
        </div>
        {cacheError && <p role="alert">{cacheError}</p>}
        <label className="reader-settings-select-row">
          <span>
            <strong>다운로드하지 않은 만화 열기</strong>
            <small>망가요미·APK 이미지 소스에서 지원합니다.</small>
          </span>
          <select
            value={sourceReading.mode}
            onChange={(e) => changeSourceReading({ mode: e.target.value as SourceReadingPreferences['mode'] })}
          >
            <option value="stream-save">바로 읽으면서 회차 저장</option>
            <option value="stream">저장 없이 바로 읽기</option>
            <option value="download">다운로드 완료 후 읽기</option>
          </select>
        </label>
        <label className="reader-settings-select-row">
          <span>
            <strong>목록·작품 정보 최대 재사용 시간</strong>
            <small>기간이 지나면 다시 확인합니다. 새로고침은 즉시 반영됩니다.</small>
          </span>
          <select
            value={sourceReading.listMinutes}
            onChange={(e) =>
              changeSourceReading({ listMinutes: Number(e.target.value) as SourceReadingPreferences['listMinutes'] })
            }
          >
            <option value={0}>사용 안 함</option>
            <option value={2}>2분</option>
            <option value={30}>30분</option>
            <option value={360}>6시간</option>
          </select>
        </label>
        <label className="reader-settings-select-row">
          <span>
            <strong>표지 이미지 재사용</strong>
          </span>
          <select
            value={sourceReading.coverHours}
            onChange={(e) =>
              changeSourceReading({ coverHours: Number(e.target.value) as SourceReadingPreferences['coverHours'] })
            }
          >
            <option value={0}>사용 안 함</option>
            <option value={1}>1시간</option>
            <option value={24}>1일</option>
            <option value={168}>7일</option>
          </select>
        </label>
        <label className="reader-settings-select-row">
          <span>
            <strong>읽는 이미지 임시 보관</strong>
            <small>서버 메모리에 최대 64MB까지 보관합니다. 영구 저장은 하지 않습니다.</small>
          </span>
          <select
            value={sourceReading.imageMinutes}
            onChange={(e) =>
              changeSourceReading({ imageMinutes: Number(e.target.value) as SourceReadingPreferences['imageMinutes'] })
            }
          >
            <option value={0}>사용 안 함</option>
            <option value={2}>2분</option>
            <option value={10}>10분</option>
          </select>
        </label>
        <label className="reader-settings-select-row">
          <span>
            <strong>다음 이미지 미리 불러오기</strong>
            <small>데이터 절약 모드에서는 현재 페이지만 불러옵니다.</small>
          </span>
          <select
            value={sourceReading.prefetch}
            onChange={(e) =>
              changeSourceReading({ prefetch: Number(e.target.value) as SourceReadingPreferences['prefetch'] })
            }
          >
            <option value={0}>사용 안 함</option>
            <option value={2}>2장</option>
            <option value={4}>4장</option>
            <option value={8}>8장</option>
          </select>
        </label>
      </section>
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
