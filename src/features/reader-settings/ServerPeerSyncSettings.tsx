import { useEffect, useState, type FormEvent } from 'react';
import { TaskProgressRing } from '../../components/TaskProgressRing';
import type { RemoteApiClient } from '../../services/remote/remote-api-client';
import { RemoteApiError } from '../../services/remote/remote-api-client';
import { formatBytes } from '../../utils/format';

interface BootstrapProgress {
  stage: 'preparing' | 'downloading' | 'validating' | 'restoring';
  completedBytes?: number;
  totalBytes?: number;
}

type PeerState =
  | { configured: false }
  | {
      url: string;
      status: 'ready' | 'offline' | 'blocked' | 'needs_login' | 'bootstrapping';
      lastError?: string | null;
      lastSyncedAt?: string | null;
      bootstrapProgress?: BootstrapProgress;
    };

const statusText: Record<Exclude<PeerState, { configured: false }>['status'], string> = {
  ready: '연결됨',
  offline: '상대 서버에 연결할 수 없음',
  blocked: '확인이 필요한 변경으로 동기화 중단',
  needs_login: '상대 서버에 다시 로그인 필요',
  bootstrapping: '서재 복제 중',
};

const errorText: Record<string, string> = {
  peer_bootstrap_requires_empty_library: '초기 복제는 이 서버의 책장이 비어 있을 때만 가능합니다.',
  peer_changed_during_bootstrap: '복제 중 기존 서버의 자료가 바뀌었습니다. 다시 시도해 주세요.',
  peer_backup_unavailable: '기존 서버의 백업을 받지 못했습니다. 연결과 저장 공간을 확인해 주세요.',
  peer_backup_unreachable: '기존 서버에서 백업을 받는 중 연결이 끊겼습니다. 다시 시도해 주세요.',
  peer_bootstrap_failed: '서재 복제에 실패했습니다. 두 서버의 저장 공간과 연결 상태를 확인해 주세요.',
  peer_bootstrap_library_changed: '복제 중 이 서버의 책장이 바뀌어 기존 자료를 보존하고 중단했습니다.',
  peer_book_identity_mismatch: '두 서버에 같은 ID로 다른 내용의 작품이 있어 동기화를 중단했습니다.',
  peer_event_type_unsupported: '아직 지원하지 않는 종류의 변경이 있어 동기화를 중단했습니다.',
  peer_auth_required: '기존 서버에 다시 로그인해 연결해 주세요.',
  invalid_peer_url: '서버 기본 주소를 /api 없이 입력해 주세요. HTTPS 또는 같은 PC의 localhost 주소를 지원합니다.',
};

function describeError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  return errorText[code] ?? code;
}

function progressLabel(progress: BootstrapProgress): string {
  switch (progress.stage) {
    case 'preparing':
      return '기존 서버의 백업 준비 중';
    case 'downloading':
      return '기존 서버의 백업 받는 중';
    case 'validating':
      return '백업 검사 중';
    case 'restoring':
      return '이 서버에 서재 복원 중';
  }
}

export function ServerPeerSyncSettings({ client }: { readonly client: Pick<RemoteApiClient, 'request'> }) {
  const [peer, setPeer] = useState<PeerState>();
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    let cancelled = false;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await client.request<PeerState>('/sync/peer');
        if (!cancelled) {
          setPeer(result);
          setLoadError('');
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof RemoteApiError && error.status === 404
              ? '이 서버 버전은 서버 간 동기화를 지원하지 않습니다.'
              : '서버 간 동기화 상태를 불러오지 못했습니다.',
          );
        }
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client]);

  const refresh = async () => setPeer(await client.request<PeerState>('/sync/peer'));
  const bootstrap = async () => {
    await client.request('/sync/peer/bootstrap', { method: 'POST' }, 60 * 60_000 + 30_000);
    await refresh();
  };
  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setActionError('');
    try {
      await client.request(
        '/sync/peer',
        {
          method: 'POST',
          body: JSON.stringify({ url: url.trim(), username, password, startFromNow: true, requireEmptyLibrary: true }),
        },
        20_000,
      );
      setPassword('');
      await refresh();
      await bootstrap();
    } catch (error) {
      setActionError(describeError(error));
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const run = async (action: 'bootstrap' | 'run' | 'disconnect') => {
    setBusy(true);
    setActionError('');
    try {
      if (action === 'bootstrap') await bootstrap();
      else {
        await client.request(`/sync/peer${action === 'run' ? '/run' : ''}`, {
          method: action === 'run' ? 'POST' : 'DELETE',
        });
        await refresh();
      }
    } catch (error) {
      setActionError(describeError(error));
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const configuredPeer = peer && 'url' in peer ? peer : undefined;
  const progress = configuredPeer?.bootstrapProgress;
  const percent =
    progress?.stage === 'downloading' &&
    typeof progress.totalBytes === 'number' &&
    progress.totalBytes > 0 &&
    typeof progress.completedBytes === 'number'
      ? (progress.completedBytes / progress.totalBytes) * 100
      : undefined;

  return (
    <section aria-labelledby="server-peer-sync-title">
      <h3 id="server-peer-sync-title">다른 서버의 서재를 이 서버에 보관</h3>
      <p>
        현재 서버의 책장이 비어 있으면 기존 self-host 서재를 한 번 복제할 수 있습니다. 이후에는 새 독서 위치만
        양방향으로 동기화합니다. 새 작품·원본 변경·주석은 아직 자동으로 따라오지 않습니다.
      </p>
      {loadError && <p role="alert">{loadError}</p>}
      {peer === undefined && !loadError && <p role="status">서버 연결 상태를 불러오는 중입니다.</p>}
      {configuredPeer ? (
        <>
          <p>
            연결 서버: <strong>{configuredPeer.url}</strong> · {statusText[configuredPeer.status]}
          </p>
          {configuredPeer.lastError && (
            <p role="alert">{errorText[configuredPeer.lastError] ?? configuredPeer.lastError}</p>
          )}
          {progress && (
            <p role="status">
              <TaskProgressRing
                percent={percent}
                label={progressLabel(progress)}
                detail={
                  progress.stage === 'downloading' && typeof progress.completedBytes === 'number'
                    ? `${formatBytes(progress.completedBytes)}${progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''}`
                    : undefined
                }
              />{' '}
              {progressLabel(progress)}
            </p>
          )}
          {configuredPeer.status === 'bootstrapping' && !progress && (
            <p>
              {busy
                ? '기존 서버의 백업을 준비하고 있습니다.'
                : '이전 복제가 중단되었습니다. 책장이 비어 있다면 다시 시도할 수 있습니다.'}
            </p>
          )}
          {configuredPeer.status !== 'ready' && !progress && (
            <button type="button" className="secondary-btn" disabled={busy} onClick={() => void run('bootstrap')}>
              빈 서재 복제 다시 시도
            </button>
          )}
          <button type="button" className="secondary-btn" disabled={busy || !!progress} onClick={() => void run('run')}>
            독서 위치 지금 동기화
          </button>
          <button
            type="button"
            className="ghost-btn"
            disabled={busy || !!progress}
            onClick={() => void run('disconnect')}
          >
            서버 연결 해제
          </button>
        </>
      ) : peer && !loadError ? (
        <form onSubmit={(event) => void connect(event)}>
          <label>
            기존 서버 주소
            <input
              type="url"
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://reader.example.com"
            />
          </label>
          <label>
            기존 서버 계정
            <input
              required
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            비밀번호
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <p>주소와 계정은 기존 서버 접속에 사용합니다. 비밀번호는 서버에 보관하지 않습니다.</p>
          <button className="primary-btn" disabled={busy}>
            빈 서재에 복제하고 연결
          </button>
        </form>
      ) : null}
      {actionError && <p role="alert">{actionError}</p>}
    </section>
  );
}
