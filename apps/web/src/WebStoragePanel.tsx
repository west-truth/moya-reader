import { useEffect, useId, useState } from 'react';
import { HardDrive, RefreshCw, ShieldCheck } from 'lucide-react';
import { formatBytes } from '../../../src/utils/format';
import { readBrowserStorage, requestBrowserPersistence, type BrowserStorageStatus } from './browser-storage';
import './web.css';

export function WebStoragePanel() {
  const titleId = useId();
  const [status, setStatus] = useState<BrowserStorageStatus>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void readBrowserStorage()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active) setMessage('브라우저가 저장 공간 정보를 제공하지 않았습니다.');
      });
    return () => {
      active = false;
    };
  }, []);
  async function refresh(protect = false) {
    setBusy(true);
    try {
      if (protect) {
        const granted = await requestBrowserPersistence();
        setMessage(
          granted
            ? '브라우저의 자동 정리로부터 책장을 보호합니다.'
            : '브라우저가 보호 요청을 허용하지 않았습니다. 기본 자동 저장은 계속 사용할 수 있습니다.',
        );
      }
      setStatus(await readBrowserStorage());
    } catch {
      setMessage('저장 공간을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }
  const remaining =
    status?.quota !== undefined && status.usage !== undefined ? Math.max(0, status.quota - status.usage) : undefined;
  const pressure =
    remaining !== undefined &&
    status?.quota &&
    (remaining < 64 * 1024 * 1024 || (status.usage ?? 0) / status.quota >= 0.8);
  return (
    <section className="web-storage-panel" aria-labelledby={titleId} aria-busy={busy}>
      <h3 id={titleId}>
        <HardDrive size={18} aria-hidden="true" /> 이 기기에 저장
      </h3>
      <p>책과 읽던 위치는 자동 저장됩니다. 브라우저를 닫아도 다음에 이어 읽을 수 있어요.</p>
      <dl>
        <div>
          <dt>사용 중</dt>
          <dd>{status?.usage === undefined ? '확인할 수 없음' : formatBytes(status.usage)}</dd>
        </div>
        <div>
          <dt>브라우저 저장 한도</dt>
          <dd>{status?.quota === undefined ? '확인할 수 없음' : formatBytes(status.quota)}</dd>
        </div>
        <div>
          <dt>남은 저장 여유</dt>
          <dd>{remaining === undefined ? '확인할 수 없음' : `약 ${formatBytes(remaining)}`}</dd>
        </div>
        <div>
          <dt>자동 정리 방지</dt>
          <dd>
            {status?.persistent === true ? '보호됨' : status?.persistent === false ? '기본 저장' : '확인할 수 없음'}
          </dd>
        </div>
      </dl>
      {Boolean(pressure) && (
        <p role="status">
          저장 공간이 부족해지고 있습니다. 원본과 백업을 보관한 뒤 불필요한 책을 정리해 주세요. 큰 파일은 처리 중
          원본보다 많은 여유 공간이 필요합니다.
        </p>
      )}
      <div className="web-storage-actions">
        <button type="button" className="ghost-btn" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw size={15} /> 용량 확인
        </button>
        {status?.canRequestPersistence && !status.persistent && (
          <button type="button" className="ghost-btn" disabled={busy} onClick={() => void refresh(true)}>
            <ShieldCheck size={15} /> 저장 보호 요청
          </button>
        )}
      </div>
      {message && <p role="status">{message}</p>}
      <details className="web-settings-details">
        <summary>저장과 백업 안내</summary>
        <p className="field-help">
          저장 보호 요청이 승인되면 브라우저의 자동 정리 대상에서 제외됩니다. 사이트 데이터를 직접 삭제하면 책장도
          삭제됩니다. 시크릿 모드는 장기 보관에 적합하지 않습니다.
        </p>
        <p className="field-help">
          백업은 중요한 책과 기록을 별도로 보관하는 선택 기능입니다. 표시 용량은 브라우저의 추정치이며 실제 디스크
          여유와 다를 수 있습니다.
        </p>
      </details>
    </section>
  );
}
