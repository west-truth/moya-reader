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
}: {
  readonly current?: DesktopServerSelection;
  readonly onClose: () => void;
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
  return (
    <div className="modal-backdrop">
      <section
        className="self-host-auth-card"
        role="dialog"
        aria-modal="true"
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
          {saved && (
            <p role="status">선택을 저장했습니다. 실행 중인 작업은 그대로 유지되며 다음 앱 시작에 적용됩니다.</p>
          )}
          <div className="dialog-actions">
            <button type="button" className="secondary-btn" onClick={onClose}>
              돌아가기
            </button>
            <button type="submit" className="primary-btn">
              다음 시작에 적용
            </button>
          </div>
        </form>
      </section>
    </div>
  );
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

export function DesktopRemoteHome({
  selection,
  configurationError,
}: {
  readonly selection?: DesktopServerSelection;
  readonly configurationError?: string;
}) {
  const [error, setError] = useState(configurationError ?? '');
  const [opening, setOpening] = useState(false);
  const [ready, setReady] = useState(false);
  const autoOpened = useRef(false);
  const address = selection?.mode === 'remote' ? selection.serverUrl : undefined;

  const open = useCallback(async () => {
    if (!address || opening) return;
    setOpening(true);
    setError('');
    try {
      await invoke('desktop_remote_server_open', { address });
      setReady(true);
    } catch (failure) {
      setError(String(failure instanceof Error ? failure.message : failure));
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
    <DesktopWindowShell showSharing={false}>
      <main className="self-host-auth-screen">
        <section className="self-host-auth-card">
          <h1>기존 서버에 접속</h1>
          {address && <p>{address}</p>}
          <p>서버의 기존 로그인 화면을 별도 창에서 엽니다. 서버의 서재 자료는 이 PC로 복사하지 않습니다.</p>
          {error && <p role="alert">{error}</p>}
          {ready && !error && <p role="status">서버 창을 열었습니다. 닫아도 이 화면에서 다시 열 수 있습니다.</p>}
          {address && (
            <button className="primary-btn" disabled={opening} onClick={() => void open()}>
              {opening ? '연결 중…' : '서버 창 열기'}
            </button>
          )}
          <button className="secondary-btn" onClick={() => window.dispatchEvent(new Event(CHOICE_EVENT))}>
            사용할 서재 변경
          </button>
          <button
            className="secondary-btn"
            onClick={() => void invoke('desktop_embedded_server_close', { keepRunning: false })}
          >
            모야 종료
          </button>
        </section>
      </main>
      <DesktopServerChoice current={selection} />
    </DesktopWindowShell>
  );
}
