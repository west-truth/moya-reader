import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CloudVaultController } from '../../features/cloud-vault/useCloudVaultController';
import { googleSession } from './google-session';
import type { GoogleSession, GoogleSessionSnapshot } from './google-session';
import '../../features/cloud-vault/cloud-accounts.css';

export interface GoogleAccountSession {
  readonly clientId?: string;
  readonly managed: boolean;
  subscribe(listener: () => void): () => void;
  getSnapshot(): GoogleSessionSnapshot;
  restore(): Promise<void>;
  ready(accountId?: string): boolean;
  signOut(): void | Promise<void>;
  signIn?(): Promise<void>;
  mountButton?: GoogleSession['mountButton'];
}

export function WebGoogleAccountPanel({
  controller,
  session: googleSession = defaultSession,
}: {
  readonly controller: CloudVaultController;
  readonly session?: GoogleAccountSession;
}) {
  const session = useSyncExternalStore(googleSession.subscribe, googleSession.getSnapshot, googleSession.getSnapshot);
  const button = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [later, setLater] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const busy = controller.activity !== 'idle' || accountBusy;
  const driveConnected = controller.providerKind === 'google-drive';
  const otherConnected = controller.connected && !driveConnected;
  const ready = googleSession.ready(controller.config?.googleDriveAccountId);

  useEffect(() => {
    void googleSession.restore();
  }, [googleSession]);

  const accountAction = async (action: () => void | Promise<void>) => {
    setAccountBusy(true);
    setError('');
    try {
      await action();
      setLater(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAccountBusy(false);
    }
  };

  useEffect(() => {
    if (
      session.identity ||
      session.restoring ||
      session.restoreError ||
      !button.current ||
      !googleSession.clientId ||
      !googleSession.mountButton
    )
      return;
    const abort = new AbortController();
    const target = document.createElement('div');
    button.current.append(target);
    let cancelled = false;
    let release: (() => void) | undefined;
    setError('');
    void googleSession
      .mountButton(target, setError, abort.signal)
      .then((cleanup) => {
        if (cancelled) cleanup();
        else release = cleanup;
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Google 로그인을 불러오지 못했습니다.');
      });
    return () => {
      cancelled = true;
      abort.abort();
      release?.();
      target.remove();
    };
  }, [googleSession, session.identity, session.restoring, session.restoreError, retry]);

  return (
    <section className="cloud-account-card web-google-account" aria-label="Google 계정과 동기화" aria-busy={busy}>
      <div className="cloud-account-heading">
        <h3>Google Drive</h3>
        <span>{ready && driveConnected ? '연결됨' : session.identity ? '로그인됨' : '연결 안 됨'}</span>
      </div>
      {session.restoring ? (
        <p role="status">로그인 상태를 불러오고 있어요…</p>
      ) : session.restoreError ? (
        <>
          <p role="status">{session.restoreError}</p>
          <button className="ghost-btn" onClick={() => void googleSession.restore()}>
            연결 다시 확인
          </button>
        </>
      ) : !googleSession.clientId ? (
        <p>이 버전에는 Google 로그인 연결이 구성되지 않았습니다. 책과 독서 기록은 계속 이 기기에 저장됩니다.</p>
      ) : !session.identity ? (
        <>
          <p>Google로 로그인하고, 내 Drive에 책장을 동기화하세요. 로그인 없이도 읽을 수 있어요.</p>
          {driveConnected && (
            <p className="field-help">다시 로그인하면 {controller.providerLabel}의 동기화를 이어서 연결할 수 있어요.</p>
          )}
          {googleSession.signIn ? (
            <button
              type="button"
              className="primary-btn"
              disabled={busy}
              onClick={() => void accountAction(() => googleSession.signIn!())}
            >
              {accountBusy ? '로그인 중…' : 'Google로 로그인'}
            </button>
          ) : (
            <div ref={button} className="web-google-signin" />
          )}
          {error && !googleSession.signIn && (
            <>
              <p role="alert">{error}</p>
              <button className="ghost-btn" onClick={() => setRetry((value) => value + 1)}>
                로그인 다시 시도
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <div className="web-google-account-row">
            <span>{session.identity.label}</span>
            <button
              className="ghost-btn"
              disabled={busy}
              onClick={() => {
                void accountAction(() => googleSession.signOut());
              }}
            >
              로그아웃
            </button>
          </div>
          {otherConnected ? (
            <p>
              현재 {controller.providerLabel}에 동기화하고 있어요. Drive로 바꾸려면 아래에서 기존 연결을 해제하세요.
            </p>
          ) : ready && driveConnected ? (
            <p role="status">
              Google Drive에 연결됐어요.{' '}
              {controller.needsLegacyPassphrase
                ? '아래에서 기존 동기화 파일을 한 번 열어주세요.'
                : controller.config?.autoSync
                  ? '모야를 사용하는 동안 자동으로 동기화합니다.'
                  : '아래에서 지금 동기화할 수 있어요.'}
            </p>
          ) : later && !driveConnected ? (
            <button className="ghost-btn" onClick={() => setLater(false)}>
              Drive 동기화 설정
            </button>
          ) : (
            <div className="web-google-setup">
              <p>
                {driveConnected
                  ? 'Drive를 다시 연결하면 이 기기에 쌓인 변경 사항도 함께 동기화합니다.'
                  : '내 Google Drive에 책장 동기화를 켤까요?'}
              </p>
              {!driveConnected && (
                <label className="web-google-files">
                  <input
                    type="checkbox"
                    checked={controller.config?.scope.sourceFiles ?? false}
                    disabled={busy || !controller.config}
                    onChange={(event) => void controller.setScope('sourceFiles', event.target.checked)}
                  />
                  <span>
                    책 파일과 표지도 동기화
                    <small>다른 기기에서 파일을 다시 가져오지 않고 읽을 수 있어요. 내 Drive 공간을 사용합니다.</small>
                  </span>
                </label>
              )}
              <div className="web-storage-actions">
                <button
                  className="primary-btn"
                  disabled={busy || !controller.connectGoogleDrive}
                  onClick={() => void controller.connectGoogleDrive?.()}
                >
                  {controller.activity === 'connecting'
                    ? '연결 중…'
                    : driveConnected
                      ? 'Drive 다시 연결'
                      : 'Google Drive 동기화 켜기'}
                </button>
                {!driveConnected && (
                  <button className="ghost-btn" disabled={busy} onClick={() => setLater(true)}>
                    나중에
                  </button>
                )}
              </div>
            </div>
          )}
          <details className="web-settings-details">
            <summary>연결 안내</summary>
            <p>
              로그인만으로 책이 업로드되지는 않습니다. 동기화를 켜면 선택한 항목을 내 Drive의 Moya Sync 폴더에
              저장합니다. 동기화 자료는 Google 계정의 접근 권한으로 보호합니다.
            </p>
            <p>별도 모야 비밀번호 없이 Google 계정의 Drive 권한으로 동기화합니다.</p>
            <p>
              {googleSession.managed
                ? '브라우저를 다시 열어도 로그인과 Drive 연결을 복원합니다. Google에서 권한을 취소했거나 로그인이 만료된 경우에만 다시 연결해주세요. '
                : '다시 방문하거나 Google 연결이 만료되면 재연결이 필요할 수 있어요. '}
              인터넷이 없거나 로그아웃해도 저장된 책은 읽을 수 있고, 다음 연결 때 동기화를 이어갑니다.
            </p>
            <p>
              이 기기의 책장은 계정별로 나뉘지 않습니다. 계정을 바꿔 동기화를 켜면 현재 책장과 새 계정의 기록을
              합칩니다.
            </p>
          </details>
        </>
      )}
      {error && (session.identity || googleSession.signIn) && <p role="alert">{error}</p>}
    </section>
  );
}

const defaultSession: GoogleAccountSession = googleSession;
