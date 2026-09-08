import { KeyRound, LoaderCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';

interface NovelpiaAuthSettingsProps {
  readonly enabled: boolean;
  readonly credentialsRemembered: boolean;
  readonly busy: boolean;
  readonly disabled: boolean;
  connectCredentials(email: string, password: string): Promise<boolean>;
  connectLoginKey(loginKey: string): Promise<boolean>;
  enableSaved(): Promise<boolean>;
  disable(): Promise<boolean>;
}

export function NovelpiaAuthSettings({
  enabled,
  credentialsRemembered,
  busy,
  disabled,
  connectCredentials,
  connectLoginKey,
  enableSaved,
  disable,
}: NovelpiaAuthSettingsProps) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [method, setMethod] = useState<'credentials' | 'login-key'>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginKey, setLoginKey] = useState('');

  const submitCredentials = (event: FormEvent) => {
    event.preventDefault();
    void connectCredentials(email, password).then((connected) => {
      if (!connected) return;
      setEmail('');
      setPassword('');
      setEditorOpen(false);
    });
  };

  const submitLoginKey = (event: FormEvent) => {
    event.preventDefault();
    void connectLoginKey(loginKey).then((connected) => {
      if (!connected) return;
      setLoginKey('');
      setEditorOpen(false);
    });
  };

  const stateLabel = enabled
    ? credentialsRemembered
      ? '19세 검색 사용 중 · 만료 시 자동 로그인'
      : '19세 검색 사용 중 · LOGINKEY 저장됨'
    : credentialsRemembered
      ? '로그인 정보 저장됨 · 현재 사용 안 함'
      : '로그인 사용 안 함';

  return (
    <div className="extension-auth-platform-card">
      <div className="extension-auth-platform-row">
        <div>
          <strong>노벨피아</strong>
          <span>{stateLabel}</span>
        </div>
        <div className="extension-inline-actions">
          {!enabled && credentialsRemembered && (
            <button
              className="primary-btn"
              type="button"
              disabled={disabled || busy}
              onClick={() => void enableSaved()}
            >
              다시 사용
            </button>
          )}
          <button
            className="ghost-btn"
            type="button"
            disabled={disabled || busy}
            aria-expanded={editorOpen}
            onClick={() => setEditorOpen((current) => !current)}
          >
            <KeyRound size={14} /> {enabled || credentialsRemembered ? '인증 변경' : '로그인 설정'}
          </button>
          {enabled && (
            <button className="ghost-btn" type="button" disabled={disabled || busy} onClick={() => void disable()}>
              사용 중지
            </button>
          )}
        </div>
      </div>

      {editorOpen && (
        <div className="extension-direct-auth-editor">
          <div className="extension-auth-methods" role="tablist" aria-label="노벨피아 로그인 방식">
            <button
              type="button"
              role="tab"
              aria-selected={method === 'credentials'}
              className={method === 'credentials' ? 'is-active' : ''}
              onClick={() => setMethod('credentials')}
            >
              이메일 계정
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={method === 'login-key'}
              className={method === 'login-key' ? 'is-active' : ''}
              onClick={() => setMethod('login-key')}
            >
              소셜 계정 · LOGINKEY
            </button>
          </div>

          {method === 'credentials' ? (
            <form className="extension-direct-auth-form" onSubmit={submitCredentials}>
              <label>
                <span>이메일</span>
                <input
                  type="email"
                  autoComplete="username"
                  value={email}
                  required
                  disabled={busy}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label>
                <span>비밀번호</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  required
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <p>
                이 서버의 정보 수집기에 로그인 정보와 발급된 LOGINKEY를 저장합니다. 키가 만료되면 자동으로 다시
                로그인합니다.
              </p>
              <button className="primary-btn" type="submit" disabled={busy || !email.trim() || !password}>
                {busy && <LoaderCircle size={14} className="spin" />} 연결하고 사용
              </button>
            </form>
          ) : (
            <form className="extension-direct-auth-form" onSubmit={submitLoginKey}>
              <label>
                <span>LOGINKEY</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={loginKey}
                  required
                  minLength={40}
                  disabled={busy}
                  onChange={(event) => setLoginKey(event.target.value)}
                />
              </label>
              <p>소셜 계정은 로그인된 노벨피아 브라우저 쿠키의 LOGINKEY 값만 입력합니다. 값은 이 서버에 저장됩니다.</p>
              <button className="primary-btn" type="submit" disabled={busy || loginKey.trim().length < 40}>
                {busy && <LoaderCircle size={14} className="spin" />} 확인하고 사용
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
