import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { type EmbeddedSharingStatus } from './EmbeddedServerSharing';
import { DesktopWindowShell } from './DesktopWindowFrame';
import { EmbeddedAccessContext } from './embedded-access-context';
import { ToastHost } from '../shared/ui/ToastHost';

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
  recovering: '이전 실행을 정리하고 저장된 서재를 복구하고 있습니다.',
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
  const [connectionError, setConnectionError] = useState('');
  const [closeRequested, setCloseRequested] = useState(false);
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
        setConnectionError('');
        setStatus(next);
        if (next.running) timer = setTimeout(() => void update(false), 500);
      } catch (failure) {
        if (!disposed) {
          setConnectionError(String(failure));
          if (!start) timer = setTimeout(() => void update(false), 500);
        }
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
    return () => {
      void unlisten.then((dispose) => dispose());
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
  const failure = error || connectionError || status.error;
  // A missed native status response does not mean the HTTP reader stopped.
  // Keep its mounted state until the native process reports an actual failure.
  const readerReady = status.phase === 'ready' && !error && !status.error;
  return (
    <>
      {readerReady ? (
        <EmbeddedAccessContext.Provider
          value={{ connection: { url: status.url!, authToken: status.authToken! }, status }}
        >
          {content}
        </EmbeddedAccessContext.Provider>
      ) : (
        <DesktopWindowShell>
          <main className="self-host-auth-screen">
            <section className="self-host-auth-card" aria-live="polite">
              <h1>
                {failure ? '서재 서버를 확인해 주세요' : status.phase === 'stopping' ? '모야 종료 중' : '모야 시작 중'}
              </h1>
              <p role={failure ? 'alert' : 'status'}>
                {failure || phases[status.phase] || '서재 서버가 종료되었습니다.'}
              </p>
              <button className="ghost-btn" onClick={() => window.dispatchEvent(new Event('moya-open-server-choice'))}>
                서재 선택
              </button>
              {failure && !status.running && (
                <button
                  className="primary-btn"
                  onClick={() => {
                    setError('');
                    setConnectionError('');
                    setStatus({ phase: 'preparing', running: false });
                    setAttempt((value) => value + 1);
                  }}
                >
                  다시 시도
                </button>
              )}
              {status.phase !== 'stopping' && (
                <button className="ghost-btn" onClick={() => void close(false)}>
                  모야 종료
                </button>
              )}
            </section>
          </main>
        </DesktopWindowShell>
      )}
      {readerReady && connectionError && (
        <ToastHost
          toasts={[
            {
              id: 'native-status',
              tone: 'warning',
              message: `${connectionError} · 서버 상태를 다시 확인하고 있습니다.`,
            },
          ]}
          readerActive={true}
          addonOpen={false}
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
              <button className="ghost-btn" onClick={() => setCloseRequested(false)}>
                돌아가기
              </button>
              <button className="ghost-btn" onClick={() => void close(true)}>
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
