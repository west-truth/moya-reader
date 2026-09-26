import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { DesktopWindowShell } from './DesktopWindowFrame';
import {
  normalizeDesktopServerUrl,
  readDesktopServerSelection,
  saveDesktopServerSelection,
  type DesktopServerSelection,
} from './desktop-server-selection';

const CHOICE_EVENT = 'moya-open-server-choice';

function SelectionForm({
  current,
  onClose,
  inline = false,
}: {
  readonly current?: DesktopServerSelection;
  readonly onClose?: () => void;
  readonly inline?: boolean;
}) {
  const [mode, setMode] = useState<'embedded' | 'remote'>(current?.mode ?? 'embedded');
  const [address, setAddress] = useState(current?.mode === 'remote' ? current.serverUrl : '');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      const selection: DesktopServerSelection =
        mode === 'remote' ? { version: 1, mode, serverUrl: normalizeDesktopServerUrl(address) } : { version: 1, mode };
      saveDesktopServerSelection(window.localStorage, selection);
      setSaved(true);
    } catch (failure) {
      setError(String(failure instanceof Error ? failure.message : failure));
    }
  };
  const form = (
    <section
      className={inline ? 'settings-section-card desktop-server-choice' : 'self-host-auth-card desktop-server-choice'}
      role={inline ? undefined : 'dialog'}
      aria-modal={inline ? undefined : true}
      aria-labelledby="desktop-server-choice-title"
    >
      <h2 id="desktop-server-choice-title">사용할 서재 선택</h2>
      <p>한 번에 한 서버의 서재를 사용합니다. 이 선택은 작품을 복사하거나 병합하지 않습니다.</p>
      <form onSubmit={submit}>
        <label>
          <input
            type="radio"
            name="desktop-server-mode"
            checked={mode === 'embedded'}
            onChange={() => {
              setMode('embedded');
              setSaved(false);
            }}
          />
          이 PC의 서재
        </label>
        <label>
          <input
            type="radio"
            name="desktop-server-mode"
            checked={mode === 'remote'}
            onChange={() => {
              setMode('remote');
              setSaved(false);
            }}
          />
          기존 서버에 접속
        </label>
        {mode === 'remote' && (
          <label>
            서버 첫 화면 주소
            <input
              type="url"
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
                setSaved(false);
              }}
              placeholder="https://reader.example.com/"
              required
            />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        {saved && <p role="status">선택을 저장했습니다. 실행 중인 작업은 그대로 유지되며 다음 앱 시작에 적용됩니다.</p>}
        <div className="dialog-actions">
          {onClose && (
            <button type="button" className="ghost-btn" onClick={onClose}>
              돌아가기
            </button>
          )}
          <button type="submit" className="primary-btn">
            다음 시작에 적용
          </button>
        </div>
      </form>
    </section>
  );
  return inline ? form : <div className="modal-backdrop">{form}</div>;
}

export function DesktopServerSelectionSettings() {
  const [current] = useState(() => {
    try {
      return readDesktopServerSelection(window.localStorage);
    } catch {
      return undefined;
    }
  });
  return <SelectionForm current={current} inline />;
}

export function DesktopServerChoice({ current }: { readonly current?: DesktopServerSelection }) {
  const [open, setOpen] = useState(false);
  const [shownSelection, setShownSelection] = useState(current);
  useEffect(() => {
    const show = () => {
      try {
        setShownSelection(readDesktopServerSelection(window.localStorage));
      } catch {
        setShownSelection(current);
      }
      setOpen(true);
    };
    window.addEventListener(CHOICE_EVENT, show);
    return () => window.removeEventListener(CHOICE_EVENT, show);
  }, [current]);
  return open ? <SelectionForm current={shownSelection} onClose={() => setOpen(false)} /> : null;
}

function connectionFailure(value: unknown, address?: string) {
  const row = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  const message = typeof row?.message === 'string' ? row.message : String(value);
  const stage = typeof row?.stage === 'string' ? row.stage : '서버 창 열기';
  const code = typeof row?.code === 'string' ? row.code : 'connection_error';
  const detail = typeof row?.detail === 'string' ? row.detail : '';
  let origin = '주소 확인 실패';
  try {
    if (address) origin = normalizeDesktopServerUrl(address);
  } catch {
    /* Do not echo credentials from invalid URLs. */
  }
  return {
    message,
    diagnostic: [new Date().toISOString(), `서버: ${origin}`, `단계: ${stage}`, `코드: ${code}`, message, detail]
      .filter(Boolean)
      .join('\n'),
  };
}

export function DesktopRemoteHome({
  selection,
  configurationError,
}: {
  readonly selection?: DesktopServerSelection;
  readonly configurationError?: string;
}) {
  const [error, setError] = useState(configurationError ?? '');
  const [diagnostic, setDiagnostic] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [opening, setOpening] = useState(false);
  const [ready, setReady] = useState(false);
  const [browserOpened, setBrowserOpened] = useState(false);
  const autoOpened = useRef(false);
  const address = selection?.mode === 'remote' ? selection.serverUrl : undefined;

  const open = useCallback(async () => {
    if (!address || opening) return;
    setOpening(true);
    setReady(false);
    setError('');
    setDiagnostic('');
    setCopyStatus('');
    try {
      await invoke('desktop_remote_server_open', { address });
      setReady(true);
    } catch (failure) {
      const result = connectionFailure(failure, address);
      setError(result.message);
      setDiagnostic(result.diagnostic);
    } finally {
      setOpening(false);
    }
  }, [address, opening]);
  useEffect(() => {
    if (address && !autoOpened.current) {
      autoOpened.current = true;
      void open();
    }
  }, [address, open]);

  return (
    <DesktopWindowShell>
      <main className="self-host-auth-screen">
        <section className="self-host-auth-card desktop-remote-home">
          <h1>기존 서버에 접속</h1>
          {address && <p>{address}</p>}
          <p>서버의 기존 로그인 화면을 별도 창에서 엽니다. 서버의 서재 자료는 이 PC로 복사하지 않습니다.</p>
          {error && <p role="alert">{error}</p>}
          {diagnostic && (
            <details className="desktop-connection-diagnostics">
              <summary>연결 진단 보기</summary>
              <pre tabIndex={0}>{diagnostic}</pre>
              <button
                type="button"
                className="ghost-btn"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(diagnostic);
                    setCopyStatus('진단 내용을 복사했습니다.');
                  } catch {
                    setCopyStatus('자동 복사가 지원되지 않습니다. 위 내용을 선택해 복사해 주세요.');
                  }
                }}
              >
                진단 복사
              </button>
              {copyStatus && <p role="status">{copyStatus}</p>}
            </details>
          )}
          {browserOpened && <p role="status">기본 브라우저에서 서버를 열었습니다.</p>}
          {error && (
            <p>
              이전 버전 서버는 일반 브라우저에서 이용할 수 있습니다. 주소가 열리지 않으면 서버와 네트워크 연결을 확인해
              주세요.
            </p>
          )}
          {ready && !error && <p role="status">서버 창을 열었습니다. 닫아도 이 화면에서 다시 열 수 있습니다.</p>}
          <div className="desktop-remote-home-actions">
            {address && (
              <button className="primary-btn" disabled={opening} onClick={() => void open()}>
                {opening ? '연결 중…' : '서버 창 열기'}
              </button>
            )}
            {address && (
              <button
                className="ghost-btn"
                disabled={opening}
                onClick={async () => {
                  setOpening(true);
                  try {
                    await invoke('desktop_remote_server_open_browser', { address });
                    setBrowserOpened(true);
                  } catch (failure) {
                    const result = connectionFailure(failure, address);
                    setError(result.message);
                    setDiagnostic(result.diagnostic);
                  } finally {
                    setOpening(false);
                  }
                }}
              >
                일반 브라우저에서 열기
              </button>
            )}
            <button className="ghost-btn" onClick={() => window.dispatchEvent(new Event(CHOICE_EVENT))}>
              사용할 서재 변경
            </button>
            <button
              className="ghost-btn"
              onClick={() => void invoke('desktop_embedded_server_close', { keepRunning: false })}
            >
              모야 종료
            </button>
          </div>
        </section>
      </main>
      <DesktopServerChoice current={selection} />
    </DesktopWindowShell>
  );
}
