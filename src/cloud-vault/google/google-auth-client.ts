import type { GoogleIdentity } from './google-identity';

export interface ManagedGoogleSession {
  readonly identity: GoogleIdentity;
  readonly driveReady: boolean;
}
interface Access {
  readonly accessToken: string;
  readonly expiresAt: number;
}
export class GoogleAuthError extends Error {
  constructor(readonly code: string) {
    super(
      code === 'session_expired' || code === 'session_changed'
        ? '모야 로그인이 만료됐습니다. 다시 로그인하세요.'
        : code === 'account_mismatch'
          ? '연결된 Google 계정이 달라졌습니다. 새로고침한 뒤 동기화 계정을 확인해주세요.'
          : code === 'drive_reconnect'
            ? 'Google에서 Drive 재연결을 요청했습니다. 다시 연결해주세요.'
            : '로그인 서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.',
    );
  }
}

/** Persist only the opaque Moya device session. Google access tokens stay in memory; refresh tokens stay on the server. */
export class GoogleAuthClient {
  private access?: Access;
  private accessOwner?: string;
  private accessAccount?: string;
  private epoch = 0;
  private pendingToken?: Promise<string>;
  private pendingAccount?: string;
  private forceRefresh = false;
  readonly storageKey: string;
  constructor(
    readonly baseUrl: string,
    clientId: string,
    private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key),
    },
  ) {
    const url = new URL(baseUrl);
    if (
      url.origin !== baseUrl ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    ) {
      throw new Error('로그인 서버 주소는 HTTPS 또는 로컬 테스트 주소여야 합니다.');
    }
    this.storageKey = `moya:auth-session:v1:${baseUrl}:${clientId}`;
  }
  private token() {
    try {
      return this.storage.getItem(this.storageKey) ?? undefined;
    } catch {
      return;
    }
  }
  private async request<T>(path: string, body: unknown = {}, token = this.token()): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(25000),
      headers: {
        'Content-Type': 'application/json',
        'X-Moya-Auth': '1',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => ({}))) as { error?: string };
      throw new GoogleAuthError(value.error ?? 'auth_service_unavailable');
    }
    return response.json() as Promise<T>;
  }
  async nonce() {
    return (await this.request<{ nonce: string }>('/challenge')).nonce;
  }
  async login(credential: string, nonce: string): Promise<ManagedGoogleSession> {
    const epoch = this.epoch;
    const previous = this.token();
    const result = await this.request<ManagedGoogleSession & { token: string }>('/login', { credential, nonce });
    if (epoch !== this.epoch) {
      void this.request('/logout', {}, result.token).catch(() => {});
      throw new GoogleAuthError('session_changed');
    }
    try {
      this.storage.setItem(this.storageKey, result.token);
    } catch {
      void this.request('/logout', {}, result.token).catch(() => {});
      throw new Error('이 브라우저에서 로그인 저장이 차단되어 있습니다. 사이트 저장을 허용해주세요.');
    }
    this.access = undefined;
    if (previous) void this.request('/logout', {}, previous).catch(() => {});
    return result;
  }
  async restore(): Promise<ManagedGoogleSession | undefined> {
    const token = this.token();
    if (!token) return;
    const result = await this.request<ManagedGoogleSession>('/session', {}, token);
    if (token !== this.token()) throw new GoogleAuthError('session_changed');
    return result;
  }
  async connect(): Promise<ManagedGoogleSession> {
    const popup = window.open('about:blank', 'moya-google-drive', 'popup,width=520,height=680');
    if (!popup) throw new Error('Google 연결 창이 차단됐습니다. 팝업을 허용하고 다시 연결해주세요.');
    const epoch = this.epoch;
    try {
      const flow = await this.request<{ flow: string; url: string }>('/drive/start');
      const url = new URL(flow.url);
      if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth')
        throw new Error('잘못된 Google 연결 주소입니다.');
      popup.location.href = flow.url;
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        if (epoch !== this.epoch) throw new GoogleAuthError('session_changed');
        const result = await this.request<{ status: string }>('/drive/status', { flow: flow.flow });
        if (result.status === 'connected') {
          this.access = undefined;
          const session = await this.restore();
          if (!session) throw new GoogleAuthError('session_expired');
          return session;
        }
        if (result.status === 'failed')
          throw new Error('Google 연결을 완료하지 못했습니다. 같은 계정으로 권한을 허용해주세요.');
        // Polling also works when Google isolates the popup's window.opener.
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      }
      throw new Error('Google 연결 시간이 지났습니다. 다시 시도해주세요.');
    } finally {
      popup.close();
    }
  }
  async getAccessToken(accountId: string): Promise<string> {
    if (!this.token()) throw new GoogleAuthError('session_expired');
    if (
      this.accessOwner === this.token() &&
      this.accessAccount === accountId &&
      this.access &&
      this.access.expiresAt > Date.now() + 60000
    )
      return this.access.accessToken;
    if (this.pendingToken) {
      if (this.pendingAccount !== accountId) throw new GoogleAuthError('account_mismatch');
      return this.pendingToken;
    }
    const epoch = this.epoch;
    const token = this.token();
    this.pendingAccount = accountId;
    this.pendingToken = this.request<Access>('/drive/token', { accountId, forceRefresh: this.forceRefresh }, token)
      .then((value) => {
        if (epoch !== this.epoch || token !== this.token()) throw new GoogleAuthError('session_changed');
        this.access = value;
        this.accessOwner = token;
        this.accessAccount = accountId;
        this.forceRefresh = false;
        return value.accessToken;
      })
      .finally(() => {
        this.pendingToken = undefined;
      });
    return this.pendingToken;
  }
  invalidateAccess() {
    this.access = undefined;
    this.forceRefresh = true;
  }
  async disconnect() {
    this.epoch += 1;
    this.access = undefined;
    await this.request('/drive/disconnect');
  }
  async logout() {
    const token = this.token();
    this.forget();
    if (token) await this.request('/logout', {}, token);
  }
  forget() {
    this.epoch += 1;
    this.access = undefined;
    try {
      this.storage.removeItem(this.storageKey);
    } catch {
      /* local reading remains available */
    }
  }
}
