import 'fake-indexeddb/auto';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudVaultLocalStateStore, resetCloudVaultLocalStateForTests } from '../../cloud-vault/local-state';
import { CloudVaultService } from '../../cloud-vault/service';
import type { CloudVaultExternalProvider } from '../../cloud-vault/external-provider';
import { IndexedDbReaderRepository } from '../../repositories/indexeddb-reader-repository';
import type { ImportService } from '../../services/import/import-service';
import { useCloudVaultController, type CloudVaultController } from './useCloudVaultController';
import { connectDropboxWithPopup } from '../../cloud-vault/dropbox-oauth';
import { fetchDropboxAccountLabel } from '../../cloud-vault/dropbox-provider';

vi.mock('../../cloud-vault/dropbox-oauth', () => ({
  connectDropboxWithPopup: vi.fn(),
  connectDropboxWithDesktopBrowser: vi.fn(),
}));
vi.mock('../../cloud-vault/dropbox-provider', async (original) => ({
  ...(await original<object>()),
  fetchDropboxAccountLabel: vi.fn(),
}));

let root: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setInterval, clearInterval, setTimeout, clearTimeout }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await resetCloudVaultLocalStateForTests();
});

describe('social sync has no Moya password', () => {
  it.each(['google-drive', 'dropbox'] as const)(
    'connects and restores %s without entering a password',
    async (kind) => {
      const state = new CloudVaultLocalStateStore();
      await state.saveConfig({ autoSync: false });
      const sync = vi.spyOn(CloudVaultService.prototype, 'sync').mockResolvedValue({
        provider: kind,
        remoteRevision: 'rev',
        syncedAt: new Date().toISOString(),
        uploadedBytes: 10,
        matchedBooks: 0,
        waitingForSourceBooks: 0,
        appliedRecords: 0,
        quarantinedRecords: 0,
        waitingBookTitles: [],
        uploadedSourceFiles: 0,
        restoredSourceFiles: 0,
        uploadedContentBytes: 0,
        downloadedContentBytes: 0,
        uploadedAiTtsFiles: 0,
        restoredAiTtsFiles: 0,
        uploadedAiTtsBytes: 0,
        downloadedAiTtsBytes: 0,
        aiTtsObjectKeys: {},
        contentFailures: [],
      });
      const external: CloudVaultExternalProvider = {
        available: true,
        subscribe: () => () => {},
        getSnapshot: () => undefined,
        connect: vi.fn(async () => ({ accountId: 'account', label: 'Reader' })),
        isReady: () => true,
        createProvider: async () => ({
          kind: 'google-drive',
          label: 'Drive',
          read: async () => undefined,
          write: async () => ({ revision: 'rev' }),
        }),
        disconnect: vi.fn(),
      };
      vi.mocked(connectDropboxWithPopup).mockResolvedValue({
        accessToken: 'fixture-access',
        refreshToken: 'fixture-refresh',
      });
      vi.mocked(fetchDropboxAccountLabel).mockResolvedValue('Reader');
      let controller!: CloudVaultController;
      const options = {
        repository: new IndexedDbReaderRepository(),
        importService: {} as ImportService,
        deviceId: 'test-device',
        serverSyncConnected: false,
        refreshLibrary: vi.fn(async () => {}),
        notify: vi.fn(),
        confirm: () => true,
        dropboxAppKey: 'public-app-id',
        externalProvider: external,
      };
      function Harness() {
        controller = useCloudVaultController(options);
        return null;
      }
      await act(async () => {
        root = create(<Harness />);
      });
      await act(async () => {
        await vi.waitFor(() => expect(controller.activity).toBe('idle'));
      });
      await act(async () => {
        if (kind === 'google-drive') await controller.connectGoogleDrive!();
        else await controller.connectDropbox();
      });
      expect(controller.connected).toBe(true);
      expect(controller.passphrase).toBe('');
      expect(controller.needsLegacyPassphrase).toBe(false);
      await act(async () => {
        await controller.syncNow();
      });
      expect(sync).toHaveBeenLastCalledWith(expect.objectContaining({ accountAccess: true, passphrase: '' }));
      if (kind === 'dropbox') {
        expect(await new CloudVaultLocalStateStore().getDropboxCredential()).toContain('fixture-refresh');
        expect(JSON.stringify(await state.getConfig())).not.toContain('fixture-refresh');
      }
      await act(async () => {
        root!.unmount();
      });
      await act(async () => {
        root = create(<Harness />);
      });
      await act(async () => {
        await vi.waitFor(() => expect(controller.activity).toBe('idle'));
      });
      await act(async () => {
        await controller.syncNow();
      });
      expect(sync).toHaveBeenCalledTimes(2);
      expect(controller.needsLegacyPassphrase).toBe(false);
      if (kind === 'google-drive') expect(external.connect).toHaveBeenCalledTimes(1);
      else expect(connectDropboxWithPopup).toHaveBeenCalledTimes(1);
      await act(async () => {
        await controller.disconnect();
      });
      expect(await state.getDropboxCredential()).toBeUndefined();
    },
  );
});
