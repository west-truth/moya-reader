import { useEffect, useRef, useState } from 'react';
import type { InstalledExtensionManager } from '../../extensions/packages/installed-extension-manager';
import type { SourceNetworkSettings } from '../../../packages/extension-contracts/source-network-settings';

export function SourceNetworkSettingsPanel({ manager }: { manager: InstalledExtensionManager }) {
  const [snapshot, setSnapshot] = useState<SourceNetworkSettings>();
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const operation = useRef<AbortController>();
  useEffect(() => () => operation.current?.abort(), []);
  async function load() {
    if (!manager.networkSettings || snapshot || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await manager.networkSettings(undefined, controller.signal);
      if (!controller.signal.aborted) {
        setSnapshot(result);
        setAddress(result.defaultProxy);
      }
    } catch {
      if (!controller.signal.aborted) setError('연결 설정을 불러오지 못했습니다. 다시 시도해 주세요.');
    } finally {
      if (operation.current === controller) {
        operation.current = undefined;
        setBusy(false);
      }
    }
  }
  async function save(restore = false) {
    if (!snapshot || !manager.networkSettings || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await manager.networkSettings(
        { revision: snapshot.revision, defaultProxy: restore ? null : address.trim() },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setSnapshot(result);
        setAddress(result.defaultProxy);
        setMessage('저장했습니다. 다음 소스 요청부터 적용됩니다.');
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        const conflict = cause instanceof Error && cause.message.includes('source_network_conflict');
        setError(
          conflict
            ? '다른 화면에서 설정이 변경됐습니다. 새로 불러온 뒤 다시 저장해 주세요.'
            : '저장하지 못했습니다. 프록시 주소와 서버 연결 상태를 확인해 주세요.',
        );
        if (conflict) setSnapshot(undefined);
      }
    } finally {
      if (operation.current === controller) {
        operation.current = undefined;
        setBusy(false);
      }
    }
  }
  if (!manager.networkSettings) return null;
  return (
    <details
      className="source-network-settings"
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary>소스 연결 · 기본 프록시</summary>
      <form
        className="compatibility-preferences"
        aria-label="기본 프록시 설정"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="field-help">
          이 서버의 Mangayomi·Moya 소스에 적용됩니다. 개별 확장 옵션에서 기본값 사용·직접 연결·개별 프록시를 선택할 수
          있습니다.
        </p>
        <p className="field-help">
          APK 및 별도 Suwayomi 서버의 연결 설정은 포함하지 않습니다. 프록시 주소는 휴대폰이 아닌 Moya 서버에서 접근할 수
          있어야 합니다.
        </p>
        {snapshot && (
          <>
            <label className="compatibility-preference-field">
              <span>기본 프록시 주소</span>
              <input
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                value={address}
                placeholder="socks5://proxy:1080"
                onChange={(event) => {
                  setAddress(event.target.value);
                  setMessage('');
                }}
              />
            </label>
            <p className="field-help">
              HTTP·HTTPS·SOCKS5 지원. 비워서 저장하면 직접 연결합니다. 사용자명·비밀번호가 포함된 주소는 지원하지
              않습니다.
            </p>
            <p className="field-help">
              현재 기본값: {snapshot.defaultProxy || '직접 연결'}
              {snapshot.origin === 'environment' ? ' (서버 환경 설정)' : ''}
            </p>
            <div className="installed-extension-actions">
              <button type="submit" disabled={busy}>
                저장
              </button>
              <button type="button" disabled={busy} onClick={() => void save(true)}>
                서버 기본값 복원
              </button>
            </div>
          </>
        )}
        {busy && <p role="status">처리 중…</p>}
        {error && (
          <p role="alert" className="field-help warning">
            {error}
          </p>
        )}
        {!snapshot && !busy && (
          <button type="button" onClick={() => void load()}>
            다시 불러오기
          </button>
        )}
        {message && (
          <p role="status" className="field-help">
            {message}
          </p>
        )}
        <p className="field-help">
          DNS는 서버 설정을 따릅니다. 프록시를 지정하는 것만으로 DNS 암호화가 켜지지는 않습니다.
        </p>
      </form>
    </details>
  );
}
