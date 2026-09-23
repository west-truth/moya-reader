import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { EmbeddedServerSharing, type EmbeddedSharingStatus } from './EmbeddedServerSharing';

export interface EmbeddedServerConnection {
  readonly url: string;
  readonly authToken: string;
}
interface ServerStatus extends EmbeddedSharingStatus {
  readonly phase: string;
  readonly running: boolean;
  readonly url?: string;
  readonly authToken?: string;
  readonly error?: string;
}

const phases: Record<string, string> = {
  preparing: '서재 서버를 준비하고 있습니다.',
  initializing: '처음 사용할 서재를 만들고 있습니다. 잠시 기다려 주세요.',
  database: '저장된 서재를 열고 있습니다.',
  queue: '작업 목록을 준비하고 있습니다.',
  api: '서재에 연결하고 있습니다.',
  worker: '서재 작업을 준비하고 있습니다.',
  stopping: '진행 중인 작업을 저장하고 서버를 종료하고 있습니다.',
};

/** Only the native app receives this connection. Peer browsers use normal account login. */
export function EmbeddedServerGate({ children }: { children: (connection: EmbeddedServerConnection) => ReactNode }) {
  const [status, setStatus] = useState<ServerStatus>({ phase: 'preparing', running: false });
  const [error, setError] = useState('');
  const [closeRequested, setCloseRequested] = useState(false);
  const [showSharing, setShowSharing] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = async (start: boolean) => {
      try {
        const next = await invoke<ServerStatus>(
          start ? 'desktop_embedded_server_start' : 'desktop_embedded_server_status',
        );
        if (disposed) return;
        setStatus(next);
        if (next.running) timer = setTimeout(() => void update(false), 500);
      } catch (failure) {
        if (!disposed) setError(String(failure));
      }
    };
    void update(true);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [attempt]);

  useEffect(() => {
    const unlisten = listen('embedded-server-close-requested', () => setCloseRequested(true));
    const openSharing = () => setShowSharing(true);
    window.addEventListener('moya-open-server-sharing', openSharing);
    return () => {
      void unlisten.then((dispose) => dispose());
      window.removeEventListener('moya-open-server-sharing', openSharing);
    };
  }, []);

  const close = async (keepRunning: boolean) => {
    try {
      await invoke('desktop_embedded_server_close', { keepRunning });
      setCloseRequested(false);
      if (!keepRunning) setStatus((previous) => ({ ...previous, phase: 'stopping' }));
    } catch (failure) {
      setError(String(failure));
    }
  };
  // Keep the common reader runtime stable while polling the native process state.
  const content = useMemo(
    () => (status.url && status.authToken ? children({ url: status.url, authToken: status.authToken }) : undefined),
    [children, status.url, status.authToken],
  );
  const failure = error || status.error;
  return (
    <>
      {status.phase === 'ready' && !failure ? (
        content
      ) : (
        <main className="self-host-auth-screen">
          <section className="self-host-auth-card" aria-live="polite">
            <h1>
              {failure ? '서재 서버를 확인해 주세요' : status.phase === 'stopping' ? '모야 종료 중' : '모야 시작 중'}
            </h1>
            <p role={failure ? 'alert' : 'status'}>
              {failure || phases[status.phase] || '서재 서버가 종료되었습니다.'}
            </p>
            {failure && !status.running && (
              <button
                className="primary-btn"
                onClick={() => {
                  setError('');
                  setStatus({ phase: 'preparing', running: false });
                  setAttempt((value) => value + 1);
                }}
              >
                다시 시도
              </button>
            )}
            {status.phase !== 'stopping' && (
              <button className="secondary-btn" onClick={() => void close(false)}>
                모야 종료
              </button>
            )}
          </section>
        </main>
      )}
      {showSharing && status.phase === 'ready' && status.url && status.authToken && (
        <EmbeddedServerSharing
          connection={{ url: status.url, authToken: status.authToken }}
          status={status}
          onClose={() => setShowSharing(false)}
        />
      )}
      {closeRequested && status.phase !== 'stopping' && (
        <div className="modal-backdrop">
          <section
            className="self-host-auth-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="embedded-close-title"
          >
            <h2 id="embedded-close-title">모야를 닫을까요?</h2>
            <p>
              트레이에 두면 가져오기와 다른 기기의 서재 접속이 계속됩니다. 서버를 종료하면 다른 기기에서도 접속할 수
              없습니다.
            </p>
            <div className="dialog-actions">
              <button className="secondary-btn" onClick={() => setCloseRequested(false)}>
                돌아가기
              </button>
              <button className="secondary-btn" onClick={() => void close(true)}>
                트레이에서 유지
              </button>
              <button className="primary-btn" onClick={() => void close(false)}>
                서버와 모야 종료
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
