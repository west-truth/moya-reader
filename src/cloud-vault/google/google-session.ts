import { appPublicRuntimeConfig } from '../../config/public-runtime-config';
import type { GoogleIdentity } from './google-identity';
import { GoogleAuthClient, GoogleAuthError } from './google-auth-client';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}
export interface GoogleIdentityServices {
  accounts: {
    id: {
      initialize(options: {
        client_id: string;
        nonce: string;
        auto_select: boolean;
        callback(response: { credential: string }): void;
      }): void;
      renderButton(element: HTMLElement, options: Record<string, string | number>): void;
      disableAutoSelect(): void;
    };
    oauth2: {
      initTokenClient(options: {
        client_id: string;
        scope: string;
        hint: string;
        include_granted_scopes: boolean;
        callback(response: TokenResponse): void;
        error_callback(error: { type: string }): void;
      }): { requestAccessToken(options: { prompt: string }): void };
    };
  };
}

let sdkPromise: Promise<GoogleIdentityServices> | undefined;
export function loadGoogleIdentityServices(): Promise<GoogleIdentityServices> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const get = () => (globalThis as typeof globalThis & { google?: GoogleIdentityServices }).google;
    if (get()?.accounts?.id && get()?.accounts?.oauth2) {
      resolve(get()!);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    const timeout = setTimeout(() => fail(), 15000);
    const fail = () => {
      clearTimeout(timeout);
      script.remove();
      sdkPromise = undefined;
      reject(new Error('Google 로그인을 불러오지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.'));
    };
    script.onerror = fail;
    script.onload = () => {
      clearTimeout(timeout);
      const sdk = get();
      if (sdk?.accounts?.id && sdk?.accounts?.oauth2) resolve(sdk);
      else fail();
    };
    document.head.append(script);
  });
  return sdkPromise;
}

export interface GoogleSessionSnapshot {
  readonly identity?: GoogleIdentity;
  readonly driveReady: boolean;
  readonly restoring?: boolean;
  readonly restoreError?: string;
}

/** Optional persistent auth broker; direct Google token mode remains available for static-only deployments. */
export class GoogleSession {
  private snapshot: GoogleSessionSnapshot = { driveReady: false };
  private listeners = new Set<() => void>();
  private accessToken?: string;
  private tokenExpiry = 0;
  private generation = 0;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private identityTimer?: ReturnType<typeof setTimeout>;
  private sdk?: GoogleIdentityServices;
  private authorizing = false;
  private restoration?: Promise<void>;
  constructor(
    readonly clientId: string | undefined,
    private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
    private readonly verify = async (token: string, clientId: string, nonce: string) =>
      (await import('./google-identity')).verifyGoogleIdentity(token, clientId, nonce),
    private readonly loadSdk = loadGoogleIdentityServices,
    private readonly auth?: GoogleAuthClient,
  ) {}
  get managed() {
    return Boolean(this.auth);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private update(value: GoogleSessionSnapshot) {
    this.snapshot = value;
    this.listeners.forEach((listener) => listener());
  }

  restore(): Promise<void> {
    if (!this.auth || this.snapshot.identity) return Promise.resolve();
    if (this.restoration) return this.restoration;
    const generation = this.generation;
    this.update({ driveReady: false, restoring: true });
    this.restoration = this.auth
      .restore()
      .then((session) => {
        if (generation === this.generation) this.update(session ?? { driveReady: false });
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        if (error instanceof GoogleAuthError && ['session_expired', 'session_changed'].includes(error.code)) {
          this.auth?.forget();
          this.update({ driveReady: false });
        } else
          this.update({
            driveReady: false,
            restoreError: '로그인 서버에 연결하지 못했습니다. 인터넷 연결 후 다시 확인해주세요.',
          });
      })
      .finally(() => {
        this.restoration = undefined;
      });
    return this.restoration;
  }

  async mountButton(
    element: HTMLElement,
    onError: (message: string) => void,
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (!this.clientId) return () => {};
    const sdk = await this.loadSdk();
    if (signal?.aborted) return () => {};
    this.sdk = sdk;
    const nonce = this.auth ? await this.auth.nonce() : crypto.randomUUID();
    if (signal?.aborted) return () => {};
    const generation = this.generation;
    let active = true;
    sdk.accounts.id.initialize({
      client_id: this.clientId,
      nonce,
      auto_select: false,
      callback: ({ credential }) => {
        void this.verify(credential, this.clientId!, nonce)
          .then(async (identity) => {
            if (!active || signal?.aborted || generation !== this.generation) return;
            const managed = this.auth ? await this.auth.login(credential, nonce) : undefined;
            if (!active || signal?.aborted || generation !== this.generation) return;
            this.clearDrive();
            this.update(managed ?? { identity, driveReady: false });
            clearTimeout(this.identityTimer);
            if (!this.auth) this.identityTimer = setTimeout(this.signOut, Math.max(0, identity.expiresAt - Date.now()));
          })
          .catch(() => {
            if (active && !signal?.aborted) onError('Google 로그인 응답을 확인하지 못했습니다. 다시 시도하세요.');
          });
      },
    });
    sdk.accounts.id.renderButton(element, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'signin_with',
      locale: 'ko',
      width: Math.min(260, Math.max(200, element.parentElement?.clientWidth || 260)),
    });
    return () => {
      active = false;
      element.replaceChildren();
    };
  }

  async authorizeDrive(expectedAccountId?: string): Promise<{ accountId: string; label: string }> {
    const identity = this.snapshot.identity;
    if (!this.clientId || (!this.auth && !this.sdk) || !identity || identity.expiresAt <= Date.now()) {
      throw new Error('먼저 Google로 다시 로그인하세요.');
    }
    if (expectedAccountId && identity.subject !== expectedAccountId) {
      throw new Error('기존 동기화와 다른 Google 계정입니다. 기존 연결을 해제한 뒤 새 계정을 연결하세요.');
    }
    if (this.authorizing) throw new Error('Google 연결을 진행 중입니다.');
    this.authorizing = true;
    const generation = this.generation;
    try {
      if (this.auth) {
        const session = await this.auth.connect();
        if (generation !== this.generation || session.identity.subject !== identity.subject)
          throw new Error('Google 연결 계정이 변경됐습니다. 다시 연결하세요.');
        this.update(session);
        return { accountId: session.identity.subject, label: session.identity.label };
      }
      const response = await new Promise<TokenResponse>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Google 연결 시간이 지났습니다. 다시 시도하세요.')), 120000);
        const client = this.sdk!.accounts.oauth2.initTokenClient({
          client_id: this.clientId!,
          scope: `openid email ${DRIVE_SCOPE}`,
          hint: identity.subject,
          include_granted_scopes: false,
          callback: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          error_callback: () => {
            clearTimeout(timeout);
            reject(new Error('Google 연결 창이 닫혔거나 차단됐습니다. 다시 시도하세요.'));
          },
        });
        client.requestAccessToken({ prompt: '' });
      });
      if (
        response.error ||
        !response.access_token ||
        !response.scope?.split(' ').includes(DRIVE_SCOPE) ||
        !Number.isFinite(response.expires_in) ||
        response.expires_in! <= 60
      ) {
        throw new Error('Drive 접근이 허용되지 않았습니다. 로그인과 이 기기의 책은 그대로 사용할 수 있습니다.');
      }
      const info = await this.fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${response.access_token}` },
        cache: 'no-store',
        redirect: 'error',
      });
      if (!info.ok) throw new Error('Drive 계정을 확인하지 못했습니다. 다시 연결하세요.');
      const account = (await info.json()) as { sub?: string };
      if (generation !== this.generation || account.sub !== identity.subject) {
        throw new Error('로그인한 계정과 Drive 계정이 다릅니다. 같은 계정을 선택하세요.');
      }
      this.accessToken = response.access_token;
      this.tokenExpiry = Math.min(Date.now() + response.expires_in! * 1000, identity.expiresAt);
      clearTimeout(this.expiryTimer);
      this.expiryTimer = setTimeout(() => this.clearDrive(), Math.max(0, this.tokenExpiry - Date.now() - 60000));
      this.update({ identity, driveReady: true });
      return { accountId: identity.subject, label: identity.label };
    } finally {
      this.authorizing = false;
    }
  }
  ready(accountId?: string): boolean {
    if (this.auth)
      return Boolean(accountId && this.snapshot.identity?.subject === accountId && this.snapshot.driveReady);
    return Boolean(
      accountId &&
      this.snapshot.identity?.subject === accountId &&
      this.accessToken &&
      this.tokenExpiry - Date.now() > 60000,
    );
  }
  async getAccessToken(accountId: string): Promise<string> {
    if (!this.ready(accountId)) throw new Error('Google Drive 연결이 만료됐습니다. 다시 연결하세요.');
    if (this.auth) {
      try {
        return await this.auth.getAccessToken(accountId);
      } catch (error) {
        if (error instanceof GoogleAuthError && error.code === 'drive_reconnect') this.clearDrive();
        if (error instanceof GoogleAuthError && error.code === 'account_mismatch') this.clearDrive();
        if (error instanceof GoogleAuthError && ['session_expired', 'session_changed'].includes(error.code))
          this.signOut();
        throw error;
      }
    }
    return this.accessToken!;
  }
  invalidateDrive = () => {
    if (this.auth) this.auth.invalidateAccess();
    else this.clearDrive();
  };
  disconnectDrive = () => {
    this.clearDrive();
    void this.auth?.disconnect().catch(() => {});
  };
  clearDrive = () => {
    clearTimeout(this.expiryTimer);
    this.accessToken = undefined;
    this.tokenExpiry = 0;
    this.update({ ...this.snapshot, driveReady: false });
  };
  signOut = () => {
    this.generation += 1;
    clearTimeout(this.identityTimer);
    this.clearDrive();
    this.sdk?.accounts.id.disableAutoSelect();
    void this.auth?.logout().catch(() => {});
    this.update({ driveReady: false });
  };
}

const { clientId, authUrl } = appPublicRuntimeConfig.googleDrive;
export const googleSession = new GoogleSession(
  clientId,
  undefined,
  undefined,
  undefined,
  authUrl && clientId ? new GoogleAuthClient(authUrl, clientId) : undefined,
);
