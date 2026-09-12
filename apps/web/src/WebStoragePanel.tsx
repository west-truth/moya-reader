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
            ? '자동 정리로부터 이 사이트의 데이터를 보호합니다. 직접 삭제하거나 기기를 잃으면 백업이 필요합니다.'
            : '브라우저가 영구 저장을 허용하지 않았습니다. 파일과 기록은 백업으로 보호해 주세요.',
        );
      }
      setStatus(await readBrowserStorage());
    } catch {
      setMessage('저장 공간을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="web-storage-panel" aria-labelledby={titleId} aria-busy={busy}>
      <h3 id={titleId}>
        <HardDrive size={18} aria-hidden="true" /> 이 기기에 저장
      </h3>
      <p>
        가져온 파일과 독서 기록은 이 브라우저에 저장됩니다. 다른 기기에서는 Dropbox 동기화 또는 백업 파일로 이어갈 수
        있습니다.
      </p>
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
          <dt>자동 정리 방지</dt>
          <dd>
            {status?.persistent === true ? '보호됨' : status?.persistent === false ? '기본 저장' : '확인할 수 없음'}
          </dd>
        </div>
      </dl>
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
      <p className="field-help">
        사이트 데이터 삭제·시크릿 모드 종료·브라우저 변경 시 서재를 잃을 수 있습니다. 책장의 백업 메뉴에서 파일로
        보관하세요. 동기화로 원본까지 복원하려면 ‘작품 파일과 표지’를 켜 주세요.
      </p>
    </section>
  );
}
