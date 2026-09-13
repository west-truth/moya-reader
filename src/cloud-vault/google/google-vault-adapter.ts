import type { CloudVaultExternalProvider } from '../external-provider';
import { googleSession } from './google-session';

export const googleVaultAdapter: CloudVaultExternalProvider = {
  available: Boolean(googleSession.clientId),
  subscribe: googleSession.subscribe,
  getSnapshot: googleSession.getSnapshot,
  connect: (accountId) => googleSession.authorizeDrive(accountId),
  isReady: (config) => googleSession.ready(config.googleDriveAccountId),
  disconnect: () => googleSession.disconnectDrive(),
  async createProvider(config) {
    const accountId = config.googleDriveAccountId;
    if (!accountId) throw new Error('Google Drive 계정 정보가 없습니다. 다시 연결하세요.');
    const { GoogleDriveCloudVaultProvider } = await import('../google-drive-provider');
    return new GoogleDriveCloudVaultProvider({
      getAccessToken: () => googleSession.getAccessToken(accountId),
      invalidate: googleSession.invalidateDrive,
    });
  },
};
