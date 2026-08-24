import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DropboxCredential } from '../cloud-vault/dropbox-provider';
import type { ExternalCatalogCachePage, ExternalSourceCredentialRecord, ExternalSourceLink } from './contracts';
import { DropboxSourceAccountBroker } from './dropbox-source-account-broker';
import { createExternalSourceCredentialKey, sealExternalSourceCredential } from './device-credential-crypto';
import type { ExternalSourceLocalState } from './local-state';

const CONNECTOR_ID = 'moya.external.dropbox.files';
function createState(
  record: ExternalSourceCredentialRecord,
  link: ExternalSourceLink,
  key: CryptoKey,
): {
  state: ExternalSourceLocalState;
  credential: () => ExternalSourceCredentialRecord | undefined;
  links: ExternalSourceLink[];
  clearCache: ReturnType<typeof vi.fn>;
} {
  let credential: ExternalSourceCredentialRecord | undefined = record;
  const links = [link];
  const cache = new Map<string, ExternalCatalogCachePage>();
  const clearCache = vi.fn(async () => cache.clear());
  return {
    credential: () => credential,
    links,
    clearCache,
    state: {
      getOrCreateCredentialKey: async () => key,
      getCredential: async () => credential,
      saveCredential: async (next) => {
        credential = next;
      },
      deleteCredential: async () => {
        credential = undefined;
      },
      getCachePage: async (id) => cache.get(id),
      saveCachePage: async (page) => {
        cache.set(page.id, page);
      },
      clearCache,
      listLinks: async () => [...links],
      saveLink: async (next) => {
        links.push(next);
      },
      getDefaultFolder: async () => undefined,
      saveDefaultFolder: async () => undefined,
      deleteDefaultFolder: async () => undefined,
      listSelectedItems: async () => [],
      saveSelectedItem: async () => undefined,
      deleteSelectedItem: async () => undefined,
    },
  };
}

describe('Dropbox source account broker', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('restores a device-protected connection automatically and disconnects without deleting links', async () => {
    vi.stubGlobal('location', { origin: 'https://reader.example', pathname: '/', protocol: 'https:' });
    const credential: DropboxCredential = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: '2999-01-01T00:00:00.000Z',
      accountId: 'account-1',
    };
    const key = await createExternalSourceCredentialKey();
    const record: ExternalSourceCredentialRecord = {
      id: `external-credential::${CONNECTOR_ID}`,
      connectorId: CONNECTOR_ID,
      accountConnectionId: 'account-1',
      label: 'Dropbox',
      credentialEnvelope: await sealExternalSourceCredential(credential, key),
      protection: 'device_key_v1',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };
    const link: ExternalSourceLink = {
      id: 'external-link-1',
      source: { connectorId: CONNECTOR_ID, accountConnectionId: 'account-1', remoteId: 'id:book' },
      localBookId: 'book-1',
      linkedAt: '2026-08-24T00:01:00.000Z',
    };
    const local = createState(record, link, key);
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ entries: [], has_more: false }), { status: 200 }),
    );
    const broker = new DropboxSourceAccountBroker(CONNECTOR_ID, 'app-key', local.state, fetchImpl);

    await broker.initialize();
    expect(broker.status()).toMatchObject({ state: 'connected', accountConnectionId: 'account-1' });
    await expect(broker.list({ accountConnectionId: 'account-1' }, new AbortController().signal)).resolves.toEqual({
      items: [],
    });

    await broker.disconnect();
    expect(broker.status()).toMatchObject({ state: 'disconnected' });
    expect(local.credential()).toBeUndefined();
    expect(local.clearCache).toHaveBeenCalledWith(CONNECTOR_ID, 'account-1');
    expect(local.links).toEqual([link]);
  });

  it('requires reauthorization when the decrypted account identity does not match its record', async () => {
    vi.stubGlobal('location', { origin: 'https://reader.example', pathname: '/', protocol: 'https:' });
    const key = await createExternalSourceCredentialKey();
    const record: ExternalSourceCredentialRecord = {
      id: `external-credential::${CONNECTOR_ID}`,
      connectorId: CONNECTOR_ID,
      accountConnectionId: 'account-1',
      label: 'Dropbox',
      credentialEnvelope: await sealExternalSourceCredential(
        { accessToken: 'access-token', accountId: 'account-2' } satisfies DropboxCredential,
        key,
      ),
      protection: 'device_key_v1',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };
    const local = createState(
      record,
      {
        id: 'unused',
        source: { connectorId: CONNECTOR_ID, remoteId: 'unused' },
        localBookId: 'unused',
        linkedAt: '2026-08-24T00:00:00.000Z',
      },
      key,
    );
    const broker = new DropboxSourceAccountBroker(CONNECTOR_ID, 'app-key', local.state);

    await broker.initialize();
    expect(broker.status()).toMatchObject({ state: 'reauthorization_required' });
  });

  it('turns a legacy passphrase record into a reconnect request without deleting it', async () => {
    vi.stubGlobal('location', { origin: 'https://reader.example', pathname: '/', protocol: 'https:' });
    const key = await createExternalSourceCredentialKey();
    const record: ExternalSourceCredentialRecord = {
      id: `external-credential::${CONNECTOR_ID}`,
      connectorId: CONNECTOR_ID,
      accountConnectionId: 'account-1',
      label: 'Dropbox',
      credentialEnvelope: '{"format":"noveldesk-cloud-secret"}',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };
    const local = createState(
      record,
      {
        id: 'unused',
        source: { connectorId: CONNECTOR_ID, remoteId: 'unused' },
        localBookId: 'unused',
        linkedAt: '2026-08-24T00:00:00.000Z',
      },
      key,
    );
    const broker = new DropboxSourceAccountBroker(CONNECTOR_ID, 'app-key', local.state);

    await broker.initialize();
    expect(broker.status()).toMatchObject({ state: 'reauthorization_required' });
    expect(local.credential()).toEqual(record);
  });
});
