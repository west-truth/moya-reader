import { useEffect, useState } from 'react';
import type {
  ContentConnectionRequest,
  ContentConnectionStatus,
} from '../../../packages/extension-contracts/source-content-service';
import type { InstalledExtensionManager } from '../../extensions/packages/installed-extension-manager';

export function InstalledSourceContentConnection({
  manager,
  sourceId,
  disabled,
}: {
  manager: InstalledExtensionManager;
  sourceId: string;
  disabled: boolean;
}) {
  const [status, setStatus] = useState<ContentConnectionStatus>();
  const [endpoint, setEndpoint] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    void manager
      .contentConnection?.(sourceId, { action: 'status' }, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) {
          setStatus(value);
          setEndpoint(value.endpoint ?? '');
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setError('연결 상태를 확인하지 못했습니다.');
      });
    return () => abort.abort();
  }, [manager, sourceId]);
  const run = async (request: ContentConnectionRequest) => {
    setBusy(true);
    setError('');
    setKey('');
    try {
      const value = await manager.contentConnection!(sourceId, request);
      setStatus(value);
      setEndpoint(value.endpoint ?? '');
    } catch {
      setError('연결을 확인하지 못했습니다. 서버 주소와 실행 상태를 확인해 주세요. 기존 연결은 유지됩니다.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="installed-source-authentication">
      <summary>본문 서버 연결</summary>
      <p className="field-help" role="status">
        {error ||
          (busy
            ? '연결 확인 중…'
            : status?.managed
              ? '서버에 등록된 연결을 사용합니다.'
              : status?.configured
                ? '저장된 연결을 사용합니다.'
                : '확장이 본문 서버를 사용하는 경우 여기에 연결하세요.')}
      </p>
      {!status && !disabled && manager.contentConnection && (
        <button type="button" disabled={busy} onClick={() => void run({ action: 'status' })}>
          연결 상태 다시 확인
        </button>
      )}
      {!status?.managed && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run({ action: 'save', endpoint: endpoint.trim(), ...(key ? { key } : {}) });
          }}
        >
          <fieldset disabled={disabled || busy || !status || !manager.contentConnection}>
            <label>
              서버 주소
              <input
                type="url"
                required
                value={endpoint}
                maxLength={2048}
                placeholder="http://localhost:9870"
                onChange={(event) => setEndpoint(event.target.value)}
              />
            </label>
            <details>
              <summary>서버에 접속 키가 설정된 경우</summary>
              <label>
                접속 키 (선택)
                <input
                  type="password"
                  autoComplete="off"
                  value={key}
                  maxLength={4096}
                  placeholder={status?.keySaved ? '저장된 키 사용' : ''}
                  onChange={(event) => setKey(event.target.value)}
                />
              </label>
            </details>
            <p className="field-help">연결은 {manager.target === 'server' ? '서버' : '이 기기'}에 저장됩니다.</p>
            <div className="installed-extension-actions">
              <button type="submit" disabled={!endpoint.trim()}>
                확인 후 저장
              </button>
              {status?.configured && (
                <button type="button" onClick={() => void run({ action: 'remove' })}>
                  연결 삭제
                </button>
              )}
            </div>
          </fieldset>
        </form>
      )}
    </details>
  );
}
