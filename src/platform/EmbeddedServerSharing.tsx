import { useEffect, useState, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ServerAccessLink } from '../features/server-access/ServerAccessLink';
import { SelfHostAuthClient, selfHostAuthErrorMessage } from '../features/auth/self-host-auth-client';
import type { EmbeddedServerConnection } from './EmbeddedServerGate';

export interface EmbeddedSharingStatus {
  readonly interfaces?: readonly { name: string; address: string }[];
  readonly sharingUrl?: string;
  readonly sharingError?: string;
}

export function EmbeddedServerSharing({
  connection,
  status,
  onClose,
}: {
  connection: EmbeddedServerConnection;
  status: EmbeddedSharingStatus;
  onClose: () => void;
}) {
  const [setupRequired, setSetupRequired] = useState<boolean>();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [host, setHost] = useState(status.interfaces?.[0]?.address ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void new SelfHostAuthClient(`${connection.url}/api`)
      .status(controller.signal)
      .then((value) => setSetupRequired(value.setupRequired))
      .catch((failure) => {
        if (!controller.signal.aborted) setError(selfHostAuthErrorMessage(failure));
      });
    return () => controller.abort();
  }, [connection.url]);
  const register = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmation) {
      setError('비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await new SelfHostAuthClient(`${connection.url}/api`).register({
        username,
        password,
        setupCode: connection.authToken,
      });
      setPassword('');
      setConfirmation('');
      setSetupRequired(false);
    } catch (failure) {
      setError(selfHostAuthErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const share = async (enabled: boolean) => {
    setError('');
    try {
      await invoke('desktop_embedded_server_share', { host: enabled ? host : null });
    } catch (failure) {
      setError(String(failure));
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        className="self-host-auth-card embedded-server-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="embedded-sharing-title"
      >
        <h2 id="embedded-sharing-title">다른 기기에서 서재 열기</h2>
        <p>
          같은 사설망이나 Tailscale에 연결된 기기에서 아래 주소를 열고 로그인하세요. 앱을 트레이에 두어도 접속할 수
          있습니다.
        </p>
        <p>접속 주소는 HTTP입니다. 신뢰하는 사설망에서 사용하세요. 인터넷 공유기 포트 개방은 필요하지 않습니다.</p>
        {setupRequired === undefined ? (
          <p>로그인 계정을 확인하고 있습니다.</p>
        ) : setupRequired ? (
          <form onSubmit={(event) => void register(event)}>
            <p>다른 기기에서 사용할 로그인 계정을 만들어 주세요.</p>
            <label>
              아이디
              <input
                autoComplete="username"
                minLength={2}
                maxLength={64}
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <label>
              비밀번호
              <input
                type="password"
                autoComplete="new-password"
                minLength={10}
                maxLength={256}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label>
              비밀번호 확인
              <input
                type="password"
                autoComplete="new-password"
                minLength={10}
                maxLength={256}
                required
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            <button className="primary-btn" disabled={busy}>
              계정 만들기
            </button>
          </form>
        ) : status.sharingUrl ? (
          <>
            <p>접속 허용 중</p>
            <ServerAccessLink url={status.sharingUrl} />
            <p>방화벽에서 차단될 경우 모야의 사설 네트워크 접속을 허용해 주세요.</p>
            <button className="primary-btn" onClick={() => void share(false)}>
              다른 기기 접속 해제
            </button>
          </>
        ) : (
          <>
            <label>
              접속을 허용할 네트워크
              <select value={host} onChange={(event) => setHost(event.target.value)}>
                {(status.interfaces ?? []).map(({ name, address }) => (
                  <option key={address} value={address}>
                    {name} · {address}
                  </option>
                ))}
              </select>
            </label>
            {!host && <p>연결된 사설망이 없습니다. Wi-Fi 또는 Tailscale 연결을 확인한 뒤 모야를 다시 실행해 주세요.</p>}
            <button className="primary-btn" disabled={!host} onClick={() => void share(true)}>
              다른 기기 접속 허용
            </button>
            <p>모야를 다시 실행하면 접속 허용은 꺼진 상태로 시작합니다.</p>
          </>
        )}
        {(error || status.sharingError) && <p role="alert">{error || status.sharingError}</p>}
        <button className="secondary-btn" onClick={onClose}>
          닫기
        </button>
      </section>
    </div>
  );
}
