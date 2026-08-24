import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExternalCatalogCachePage,
  ExternalSourceCredentialRecord,
  ExternalSourceLink,
  ExternalSourceSelectionRecord,
} from './contracts';
import { createExternalSourceCredentialKey } from './device-credential-crypto';
import type { GoogleDrivePickerPort } from './google-drive-picker';
import { GoogleDriveSourceAccountBroker } from './google-drive-source-account-broker';
import type { ExternalSourceDefaultFolder, ExternalSourceLocalState } from './local-state';

const CONNECTOR_ID = 'moya.external.google-drive.files';

function memoryState(key: CryptoKey): ExternalSourceLocalState & {
  credential: () => ExternalSourceCredentialRecord | undefined;
  selections: Map<string, ExternalSourceSelectionRecord>;
} {
  let credential: ExternalSourceCredentialRecord | undefined;
  const cache = new Map<string, ExternalCatalogCachePage>();
  const links = new Map<string, ExternalSourceLink>();
  const folders = new Map<string, ExternalSourceDefaultFolder>();
  const selections = new Map<string, ExternalSourceSelectionRecord>();
  return {
    credential: () => credential,
    selections,
    getOrCreateCredentialKey: async () => key,
    getCredential: async () => credential,
    saveCredential: async (record) => {
      credential = record;
    },
    deleteCredential: async () => {
      credential = undefined;
    },
    getCachePage: async (id) => cache.get(id),
    saveCachePage: async (page) => {
      cache.set(page.id, page);
    },
    clearCache: async () => {
      cache.clear();
    },
    listLinks: async () => [...links.values()],
    saveLink: async (link) => {
      links.set(link.id, link);
    },
    getDefaultFolder: async (connectorId, accountConnectionId) =>
      folders.get(`${connectorId}::${accountConnectionId ?? ''}`),
    saveDefaultFolder: async (folder) => {
      folders.set(`${folder.connectorId}::${folder.accountConnectionId ?? ''}`, folder);
    },
    deleteDefaultFolder: async (connectorId, accountConnectionId) => {
      folders.delete(`${connectorId}::${accountConnectionId ?? ''}`);
    },
    listSelectedItems: async (connectorId, accountConnectionId) =>
      [...selections.values()].filter(
        (record) => record.connectorId === connectorId && record.accountConnectionId === accountConnectionId,
      ),
    saveSelectedItem: async (record) => {
      selections.set(record.id, record);
    },
    deleteSelectedItem: async (id) => {
      selections.delete(id);
    },
  };
}

describe('GoogleDriveSourceAccountBroker', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('persists picker-selected files and reuses the shared list/download boundary', async () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', hostname: '127.0.0.1' } });
    const key = await createExternalSourceCredentialKey();
    const state = memoryState(key);
    const picker: GoogleDrivePickerPort = {
      open: vi.fn(async (request) => {
        await request.onToken({ accessToken: 'google-access-token', expiresInSeconds: 3600 });
        return [
          {
            id: 'drive-file-1',
            name: '선택한 작품.epub',
            mimeType: 'application/epub+zip',
            sizeBytes: 12,
          },
        ];
      }),
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/about?')) {
        return new Response(
          JSON.stringify({
            user: { displayName: '테스트 사용자', emailAddress: 'reader@example.com', permissionId: 'p1' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('alt=media')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Type': 'application/epub+zip' },
        });
      }
      if (url.includes('/files/drive-file-1?')) {
        return new Response(
          JSON.stringify({
            id: 'drive-file-1',
            name: '선택한 작품.epub',
            mimeType: 'application/epub+zip',
            size: '12',
            modifiedTime: '2026-08-24T01:02:03.000Z',
            md5Checksum: 'abcdef',
            version: '3',
            trashed: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    });
    const broker = new GoogleDriveSourceAccountBroker(
      CONNECTOR_ID,
      { clientId: 'client-id', appId: '123456', developerKey: 'developer-key' },
      state,
      picker,
      fetchImpl as typeof fetch,
    );

    expect(broker.status().state).toBe('disconnected');
    await expect(broker.pickItems()).resolves.toEqual({ selectedCount: 1, addedCount: 1 });
    expect(broker.status()).toMatchObject({
      state: 'connected',
      accountConnectionId: 'google-drive:p1',
      label: 'reader@example.com',
    });

    const page = await broker.list({ accountConnectionId: 'google-drive:p1' }, new AbortController().signal);
    expect(page.items).toEqual([
      expect.objectContaining({
        title: '선택한 작품.epub',
        formatHint: 'EPUB',
        byteLength: 12,
        remoteRevision: 'md5:abcdef',
        importability: 'supported',
      }),
    ]);
    await expect(
      broker.download(
        {
          key: page.items[0]!.key,
          fileName: page.items[0]!.title,
          mimeType: page.items[0]!.mimeType,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ file: expect.objectContaining({ name: '선택한 작품.epub', size: 3 }) });

    const restored = new GoogleDriveSourceAccountBroker(
      CONNECTOR_ID,
      { clientId: 'client-id', appId: '123456', developerKey: 'developer-key' },
      state,
      picker,
      fetchImpl as typeof fetch,
    );
    await restored.initialize();
    expect(restored.status().state).toBe('connected');
    await restored.removeSelectedItem(page.items[0]!.key);
    expect(state.selections.size).toBe(0);
  });

  it('stays visible in settings with an actionable unavailable reason when Google config is missing', async () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', hostname: '127.0.0.1' } });
    const state = memoryState(await createExternalSourceCredentialKey());
    const broker = new GoogleDriveSourceAccountBroker(CONNECTOR_ID, {}, state, { open: vi.fn() });

    expect(broker.status()).toEqual({
      state: 'unavailable',
      reason: '이 빌드에는 Google Drive OAuth Client ID, App ID, API Key가 설정되지 않았습니다.',
    });
  });
});
