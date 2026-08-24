import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ExternalCatalogCachePage,
  ExternalSourceCredentialRecord,
  ExternalSourceLink,
  ExternalSourceSelectionRecord,
} from './contracts';
import { externalSourceLinkId } from './contracts';
import {
  externalSourceDefaultFolderId,
  ExternalSourceLocalStateStore,
  resetExternalSourceLocalStateForTests,
} from './local-state';

const connectorId = 'moya.external.fixture.files';

describe('ExternalSourceLocalStateStore', () => {
  beforeEach(async () => resetExternalSourceLocalStateForTests());

  it('keeps encrypted credentials, metadata cache and remote links in the source-local database', async () => {
    const store = new ExternalSourceLocalStateStore();
    const firstKey = await store.getOrCreateCredentialKey();
    const restoredKey = await new ExternalSourceLocalStateStore().getOrCreateCredentialKey();
    expect(firstKey).toBe(restoredKey);
    expect(firstKey.extractable).toBe(false);
    const credential: ExternalSourceCredentialRecord = {
      id: 'credential-1',
      connectorId,
      accountConnectionId: 'account-1',
      label: 'Dropbox',
      credentialEnvelope: 'encrypted-only',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };
    const cache: ExternalCatalogCachePage = {
      id: 'cache-1',
      connectorId,
      accountConnectionId: 'account-1',
      queryFingerprint: '{}',
      items: [],
      fetchedAt: '2026-08-24T00:00:00.000Z',
      expiresAt: '2026-08-24T00:15:00.000Z',
      schemaVersion: 1,
    };
    const source = { connectorId, accountConnectionId: 'account-1', remoteId: 'remote-1' };
    const link: ExternalSourceLink = {
      id: externalSourceLinkId(source),
      source,
      localBookId: 'book-1',
      importedRemoteRevision: 'rev-1',
      linkedAt: '2026-08-24T00:01:00.000Z',
    };
    const defaultFolder = {
      id: externalSourceDefaultFolderId(connectorId, 'account-1'),
      connectorId,
      accountConnectionId: 'account-1',
      parentRef: '/소설/완결',
      breadcrumbs: [
        { label: '소설', parentRef: '/소설' },
        { label: '완결', parentRef: '/소설/완결' },
      ],
      updatedAt: '2026-08-24T00:02:00.000Z',
      schemaVersion: 1 as const,
    };
    const selectedItem: ExternalSourceSelectionRecord = {
      id: `${connectorId}::account-1::picked-1`,
      connectorId,
      accountConnectionId: 'account-1',
      item: {
        key: { connectorId, accountConnectionId: 'account-1', remoteId: 'picked-1' },
        kind: 'file',
        title: '선택한 작품.epub',
        mimeType: 'application/epub+zip',
        importability: 'supported',
      },
      selectedAt: '2026-08-24T00:03:00.000Z',
      updatedAt: '2026-08-24T00:03:00.000Z',
      schemaVersion: 1,
    };

    await store.saveCredential(credential);
    await store.saveCachePage(cache);
    await store.saveLink(link);
    await store.saveDefaultFolder(defaultFolder);
    await store.saveSelectedItem(selectedItem);

    expect(await store.getCredential(connectorId)).toEqual(credential);
    expect(await store.getCachePage(cache.id)).toEqual(cache);
    expect(await store.listLinks(connectorId)).toEqual([link]);
    expect(await new ExternalSourceLocalStateStore().getDefaultFolder(connectorId, 'account-1')).toEqual(defaultFolder);
    expect(await store.listSelectedItems(connectorId, 'account-1')).toEqual([selectedItem]);

    await store.deleteCredential(connectorId);
    await store.clearCache(connectorId, 'account-1');
    expect(await store.getCredential(connectorId)).toBeUndefined();
    expect(await store.getCachePage(cache.id)).toBeUndefined();
    expect(await store.listLinks(connectorId)).toEqual([link]);
    expect(await store.getDefaultFolder(connectorId, 'account-1')).toEqual(defaultFolder);

    await store.deleteDefaultFolder(connectorId, 'account-1');
    expect(await store.getDefaultFolder(connectorId, 'account-1')).toBeUndefined();
    await store.deleteSelectedItem(selectedItem.id);
    expect(await store.listSelectedItems(connectorId, 'account-1')).toEqual([]);
  });
});
