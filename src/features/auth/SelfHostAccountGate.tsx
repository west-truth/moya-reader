import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { BookOpenText, LogIn, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import type { ReaderRuntime } from '../../repositories/reader-runtime';
import { SELF_HOST_AUTH_REQUIRED_EVENT } from '../../services/remote/self-host-auth-events';
import { SelfHostAuthClient, selfHostAuthErrorMessage, type SelfHostAccount } from './self-host-auth-client';

interface SelfHostAuthContextValue {
  readonly account: SelfHostAccount;
  readonly logout: () => Promise<void>;
}

const SelfHostAuthContext = createContext<SelfHostAuthContextValue | undefined>(undefined);

export function useOptionalSelfHostAuth(): SelfHostAuthContextValue | undefined {
  return useContext(SelfHostAuthContext);
}

interface SelfHostAccountGateProps {
  readonly runtime: ReaderRuntime;
  readonly children: ReactNode;
}

type GateMode = 'loading' | 'setup' | 'login' | 'authenticated' | 'error';

export function SelfHostAccountGate({ runtime, children }: SelfHostAccountGateProps) {
  const client = useMemo(
    () => (runtime.mode === 'remote' ? new SelfHostAuthClient(runtime.apiBaseUrl ?? '/api') : undefined),
    [runtime.apiBaseUrl, runtime.mode],
  );
  const [mode, setMode] = useState<GateMode>(runtime.mode === 'remote' ? 'loading' : 'authenticated');
  const [account, setAccount] = useState<SelfHostAccount>();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [setupCodeRequired, setSetupCodeRequired] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    if (!client) return;
    setMode('loading');
    setMessage('');
    try {
      const status = await client.status();
      setSetupCodeRequired(status.setupCodeRequired);
      if (status.authenticated && status.account) {
        setAccount(status.account);
        setMode('authenticated');
      } else {
        setAccount(undefined);
        setMode(status.setupRequired ? 'setup' : 'login');
      }
    } catch (error) {
      setMode('error');
      setMessage(selfHostAuthErrorMessage(error));
    }
  }, [client]);

  useEffect(() => {
    if (!client) return;
    void refresh();
  }, [client, refresh]);

  useEffect(() => {
    if (!client) return;
    const requireLogin = () => {
      setAccount(undefined);
      setMode('login');
      setMessage('로그인 세션이 만료되었습니다. 다시 로그인해 주세요.');
    };
    globalThis.addEventListener?.(SELF_HOST_AUTH_REQUIRED_EVENT, requireLogin);
    return () => globalThis.removeEventListener?.(SELF_HOST_AUTH_REQUIRED_EVENT, requireLogin);
  }, [client]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!client || submitting) return;
    if (mode === 'setup' && password !== passwordConfirmation) {
      setMessage('비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    setSubmitting(true);
    setMessage('');
    try {
      const next =
        mode === 'setup'
          ? await client.register({
              username,
              displayName: displayName || undefined,
              password,
              setupCode: setupCode || undefined,
            })
          : await client.login({ username, password });
      setAccount(next);
      setPassword('');
      setPasswordConfirmation('');
      setSetupCode('');
      setMode('authenticated');
    } catch (error) {
      setMessage(selfHostAuthErrorMessage(error));
      if (error instanceof Error && error.message === 'account_already_registered') setMode('login');
    } finally {
      setSubmitting(false);
    }
  };

  const logout = useCallback(async () => {
    if (!client) return;
    await client.logout();
    setAccount(undefined);
    setPassword('');
    setMode('login');
  }, [client]);

  if (!client) return children;
  if (mode === 'authenticated' && account) {
    return <SelfHostAuthContext.Provider value={{ account, logout }}>{children}</SelfHostAuthContext.Provider>;
  }

  return (
    <main className="self-host-auth-screen">
      <section className="self-host-auth-card" aria-labelledby="self-host-auth-title">
        <header>
          <span className="self-host-auth-mark" aria-hidden="true">
            <BookOpenText size={28} />
          </span>
          <div>
            <p>개인용 Web</p>
            <h1 id="self-host-auth-title">
              {mode === 'setup' ? '내 계정 만들기' : mode === 'login' ? '모야에 로그인' : '서버 확인 중'}
            </h1>
          </div>
        </header>

        {mode === 'loading' && (
          <div className="self-host-auth-loading" role="status">
            <RefreshCw size={22} className="spin" aria-hidden="true" />
            <p>개인 서버의 로그인 상태를 확인하고 있습니다.</p>
          </div>
        )}

        {mode === 'error' && (
          <div className="self-host-auth-error" role="alert">
            <Server size={21} aria-hidden="true" />
            <p>{message}</p>
            <button type="button" className="primary-btn" onClick={() => void refresh()}>
              다시 확인
            </button>
          </div>
        )}

        {(mode === 'setup' || mode === 'login') && (
          <form onSubmit={(event) => void submit(event)}>
            <p className="self-host-auth-description">
              {mode === 'setup'
                ? '이 서버에서 사용할 첫 계정입니다. 기존 서버 책장은 이 계정에 그대로 연결됩니다.'
                : '한 번 로그인하면 이 기기에서는 다음 접속부터 자동으로 이어집니다.'}
            </p>
            <label>
              <span>아이디</span>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                required
                minLength={2}
                maxLength={64}
                autoFocus
              />
            </label>
            {mode === 'setup' && setupCodeRequired && (
              <label>
                <span>초기 설정 코드</span>
                <input
                  type="password"
                  value={setupCode}
                  onChange={(event) => setSetupCode(event.target.value)}
                  autoComplete="off"
                  required
                  aria-describedby="self-host-setup-code-help"
                />
                <small id="self-host-setup-code-help">
                  첫 계정 생성에만 사용하며, 이후 기기 로그인에는 필요하지 않습니다.
                </small>
              </label>
            )}
            {mode === 'setup' && (
              <label>
                <span>
                  표시 이름 <small>선택</small>
                </span>
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="name"
                  maxLength={80}
                  placeholder="비워 두면 아이디를 사용합니다"
                />
              </label>
            )}
            <label>
              <span>비밀번호</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
                required
                minLength={10}
                maxLength={256}
              />
            </label>
            {mode === 'setup' && (
              <label>
                <span>비밀번호 확인</span>
                <input
                  type="password"
                  value={passwordConfirmation}
                  onChange={(event) => setPasswordConfirmation(event.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={10}
                  maxLength={256}
                />
              </label>
            )}
            {message && (
              <p className="self-host-auth-form-error" role="alert">
                {message}
              </p>
            )}
            <button type="submit" className="primary-btn self-host-auth-submit" disabled={submitting}>
              {mode === 'setup' ? <ShieldCheck size={18} /> : <LogIn size={18} />}
              {submitting ? '확인 중...' : mode === 'setup' ? '계정 만들고 시작' : '로그인'}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
