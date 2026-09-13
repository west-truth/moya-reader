import type { GoogleSessionSnapshot } from '../cloud-vault/google/google-session';
import type { CloudVaultExternalProvider } from '../cloud-vault/external-provider';
import { GoogleDriveCloudVaultProvider } from '../cloud-vault/google-drive-provider';

interface NativeSession {
  configured: boolean;
  accountId?: string;
  label?: string;
  driveReady: boolean;
  accessToken?: string;
  expiresAt?: number;
}
type Invoke = (action: string, accountId?: string) => Promise<NativeSession>;

export class DesktopGoogleSession {
  readonly managed = true;
  clientId: string | undefined;
  private snapshot: GoogleSessionSnapshot = { driveReady: false, restoring: true };
  private listeners = new Set<() => void>();
  private restoration?: Promise<void>;
  private epoch = 0;
  private token?: { accountId: string; value: string; expiresAt: number };
  private pendingToken?: { accountId: string; promise: Promise<string> };
  constructor(
    private readonly invoke: Invoke = async (action, expectedAccountId) =>
      (await import('@tauri-apps/api/core')).invoke('desktop_google_oauth', { action, expectedAccountId }),
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private update(value: NativeSession) {
    this.epoch += 1;
    this.token = undefined;
    this.clientId = value.configured ? 'native-desktop' : undefined;
    this.snapshot = {
      identity: value.accountId
        ? { subject: value.accountId, label: value.label ?? 'Google 계정', expiresAt: Infinity }
        : undefined,
      driveReady: value.driveReady,
    };
    this.listeners.forEach((listener) => listener());
  }
  restore = (): Promise<void> => {
    if (this.snapshot.identity) return Promise.resolve();
    this.restoration ??= this.invoke('status')
      .then((value) => this.update(value))
      .catch((error: unknown) => {
        this.snapshot = { ...this.snapshot, restoring: false, restoreError: String(error) };
        this.listeners.forEach((listener) => listener());
      })
      .finally(() => {
        this.restoration = undefined;
      });
    return this.restoration;
  };
  signIn = async () => {
    this.update(await this.invoke('login'));
  };
  signOut = async () => {
    this.update(await this.invoke('logout'));
  };
  ready = (accountId?: string) =>
    Boolean(accountId && accountId === this.snapshot.identity?.subject && this.snapshot.driveReady);
  authorizeDrive = async (accountId?: string) => {
    const value = await this.invoke('connect', accountId ?? this.snapshot.identity?.subject);
    if (!value.accountId || !value.driveReady) throw new Error('Google Drive 계정을 확인하지 못했습니다.');
    this.update(value);
    return { accountId: value.accountId, label: value.label ?? 'Google 계정' };
  };
  invalidateDrive = () => {
    this.epoch += 1;
    this.token = undefined;
    this.snapshot = { ...this.snapshot, driveReady: false };
    this.listeners.forEach((listener) => listener());
  };
  getAccessToken = async (accountId: string) => {
    if (!this.ready(accountId)) throw new Error('Google Drive를 다시 연결하세요.');
    if (this.token?.accountId === accountId && this.token.expiresAt > Date.now() + 60000) return this.token.value;
    if (this.pendingToken?.accountId === accountId) return this.pendingToken.promise;
    const epoch = this.epoch;
    const promise = this.invoke('token', accountId)
      .then((value) => {
        if (epoch !== this.epoch || value.accountId !== accountId || !value.accessToken)
          throw new Error('Google Drive 계정이 변경됐습니다.');
        this.token = { accountId, value: value.accessToken, expiresAt: value.expiresAt ?? 0 };
        return value.accessToken;
      })
      .finally(() => {
        if (this.pendingToken?.promise === promise) this.pendingToken = undefined;
      });
    this.pendingToken = { accountId, promise };
    return promise;
  };
}

export const desktopGoogleSession = new DesktopGoogleSession();
export const desktopGoogleVaultAdapter: CloudVaultExternalProvider = {
  get available() {
    return Boolean(desktopGoogleSession.clientId);
  },
  subscribe: desktopGoogleSession.subscribe,
  getSnapshot: desktopGoogleSession.getSnapshot,
  connect: desktopGoogleSession.authorizeDrive,
  isReady: (config) => desktopGoogleSession.ready(config.googleDriveAccountId),
  disconnect: () => desktopGoogleSession.invalidateDrive(),
  async createProvider(config) {
    const accountId = config.googleDriveAccountId;
    if (!accountId) throw new Error('Google Drive 계정을 확인하세요.');
    return new GoogleDriveCloudVaultProvider({
      getAccessToken: () => desktopGoogleSession.getAccessToken(accountId),
      invalidate: desktopGoogleSession.invalidateDrive,
    });
  },
};
