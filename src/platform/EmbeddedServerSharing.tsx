import { useEffect, useState, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ServerAccessLink } from '../features/server-access/ServerAccessLink';
import { SelfHostAuthClient, selfHostAuthErrorMessage } from '../features/auth/self-host-auth-client';
import type { EmbeddedServerConnection } from './EmbeddedServerGate';

export interface EmbeddedSharingStatus {
  readonly interfaces?: readonly { name: string; address: string }[];
  readonly sharingUrl?: string;
  readonly sharingError?: string;
  readonly sharingPending?: boolean;
  readonly tunnelOrigin?: string;
}

export function EmbeddedServerSharing({
  connection,
  status,
  onClose,
  inline = false,
}: {
  connection: EmbeddedServerConnection;
  status: EmbeddedSharingStatus;
  onClose?: () => void;
  inline?: boolean;
}) {
  const [setupRequired, setSetupRequired] = useState<boolean>();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [mode, setMode] = useState('cloudflare');
  const [hostname, setHostname] = useState('');
  const [token, setToken] = useState('');
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
  useEffect(() => {
    if (status.sharingUrl) setToken('');
  }, [status.sharingUrl]);
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
      await invoke('desktop_embedded_server_share', {
        mode: enabled ? mode : 'off',
        host: enabled && mode === 'direct' ? host : null,
        hostname: enabled && mode === 'named' ? hostname : null,
        token: enabled && mode === 'named' ? token : null,
      });
    } catch (failure) {
      setError(String(failure));
    }
  };
  const content = (
    <section
      className={inline ? 'settings-section-card embedded-server-dialog' : 'self-host-auth-card embedded-server-dialog'}
      role={inline ? undefined : 'dialog'}
      aria-modal={inline ? undefined : true}
      aria-labelledby="embedded-sharing-title"
    >
      <h2 id="embedded-sharing-title">다른 기기에서 서재 열기</h2>
      <p>
        다른 기기에서 접속 주소를 열고 로그인하면 같은 서재를 사용할 수 있습니다. 앱을 트레이에 두어도 접속할 수
        있습니다.
      </p>

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
      ) : status.sharingPending ? (
        <>
          <p role="status">외부 접속을 연결하고 있습니다.</p>
          <button className="ghost-btn" onClick={() => void share(false)}>
            연결 취소
          </button>
        </>
      ) : status.sharingUrl ? (
        <>
          <p>접속 허용 중</p>
          <ServerAccessLink url={status.sharingUrl} />
          <p>창을 트레이에 두어도 접속은 유지됩니다. 접속을 해제하거나 모야 서버를 종료하면 연결이 끊깁니다.</p>
          {status.sharingUrl.startsWith('http:') && (
            <p>신뢰하는 사설망에서 사용하세요. 방화벽에 막히면 모야의 사설망 접속을 허용해 주세요.</p>
          )}
          <button className="ghost-btn" onClick={() => void share(false)}>
            다른 기기 접속 해제
          </button>
        </>
      ) : (
        <>
          <label>
            접속 방식
            <select aria-label="접속 방식" value={mode} onChange={(event) => setMode(event.target.value)}>
              <option value="cloudflare">간편 원격 접속 · Cloudflare (기본)</option>
              <option value="direct">같은 네트워크 / Tailscale 직접 접속</option>
              <option value="named">고정 주소 · 내 Cloudflare 터널</option>
            </select>
          </label>
          {mode === 'cloudflare' && (
            <p>
              별도 계정·도메인 설정 없이 임시 HTTPS 주소를 만듭니다. 다시 연결하면 주소가 바뀝니다. Cloudflare Quick
              Tunnel은 가동 시간이 보장되지 않는 간편 연결입니다.
            </p>
          )}
          {mode === 'direct' && (
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
              <p>HTTP 주소로 연결합니다. 같은 사설망이나 Tailscale에 연결된 기기에서 사용하세요.</p>
              {!host && <p>연결된 사설망이 없습니다. Wi-Fi 또는 Tailscale 연결을 확인해 주세요.</p>}
            </>
          )}
          {mode === 'named' && (
            <>
              <p>Cloudflare에서 만든 터널의 공개 호스트를 아래 주소에 연결해 주세요.</p>
              <code>{status.tunnelOrigin}</code>
              <label>
                고정 HTTPS 주소
                <input
                  type="url"
                  placeholder="https://reader.example.com"
                  value={hostname}
                  onChange={(event) => setHostname(event.target.value)}
                />
              </label>
              <label>
                터널 토큰
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </label>
              <small>토큰은 이번 연결에만 사용하며 저장하지 않습니다.</small>
            </>
          )}
          <button
            className="primary-btn"
            disabled={mode === 'direct' ? !host : mode === 'named' ? !hostname || !token : false}
            onClick={() => void share(true)}
          >
            다른 기기 접속 허용
          </button>
          <p>모야를 다시 실행하면 접속 허용은 꺼진 상태로 시작합니다.</p>
        </>
      )}
      {(error || status.sharingError) && <p role="alert">{error || status.sharingError}</p>}
      {onClose && (
        <button className="ghost-btn" onClick={onClose}>
          닫기
        </button>
      )}
    </section>
  );
  return inline ? content : <div className="modal-backdrop">{content}</div>;
}
