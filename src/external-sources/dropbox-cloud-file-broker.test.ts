import { describe, expect, it, vi } from 'vitest';
import type { DropboxCredentialStore } from '../cloud-vault/dropbox-provider';
import { DROPBOX_EXTERNAL_SOURCE_MAX_DOWNLOAD_BYTES, DropboxCloudFileBroker } from './dropbox-cloud-file-broker';

function credentials(): DropboxCredentialStore {
  return {
    get: async () => ({ accessToken: 'token', accountId: 'account-1' }),
    save: async () => undefined,
  };
}

const CONNECTOR_ID = 'moya.external.dropbox.files';

function fileMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    '.tag': 'file',
    id: 'id:book',
    name: 'book.epub',
    path_display: '/Novels/book.epub',
    size: 4,
    rev: 'rev-1',
    server_modified: '2026-08-24T00:00:00Z',
    is_downloadable: true,
    ...overrides,
  };
}

describe('Dropbox cloud file broker', () => {
  it('normalizes cursor-paged file and folder metadata without exposing the Vault file', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            entries: [
              fileMetadata(),
              {
                '.tag': 'folder',
                id: 'id:folder',
                name: 'Series',
                path_display: '/Series',
                path_lower: '/series',
              },
              fileMetadata({
                id: 'id:vault',
                name: 'noveldesk-vault-v1.enc.json',
                path_display: '/noveldesk-vault-v1.enc.json',
              }),
            ],
            has_more: true,
            cursor: 'provider-cursor',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ entries: [], has_more: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const broker = new DropboxCloudFileBroker(CONNECTOR_ID, 'app-key', credentials(), fetchImpl);

    const page = await broker.list({ accountConnectionId: 'account-1' }, new AbortController().signal);

    expect(page.items).toEqual([
      expect.objectContaining({
        key: { connectorId: CONNECTOR_ID, accountConnectionId: 'account-1', remoteId: 'id:book' },
        kind: 'file',
        title: 'book.epub',
        mimeType: 'application/epub+zip',
        byteLength: 4,
        remoteRevision: 'rev-1',
        importability: 'supported',
      }),
      expect.objectContaining({
        key: { connectorId: CONNECTOR_ID, accountConnectionId: 'account-1', remoteId: 'id:folder' },
        kind: 'folder',
        navigationRef: '/series',
      }),
    ]);
    expect(page.nextCursor).toMatch(/^dropbox:v1:/);
    await broker.list({ accountConnectionId: 'account-1', cursor: page.nextCursor }, new AbortController().signal);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.dropboxapi.com/2/files/list_folder',
      expect.objectContaining({ body: expect.stringContaining('"limit":100') }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.dropboxapi.com/2/files/list_folder/continue',
      expect.objectContaining({ body: JSON.stringify({ cursor: 'provider-cursor' }) }),
    );
  });

  it('continues beyond 100 items and rejects mismatched or non-progressing cursors', async () => {
    const firstItems = Array.from({ length: 100 }, (_, index) =>
      fileMetadata({ id: `id:book-${index}`, name: `book-${index}.epub` }),
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ entries: firstItems, has_more: true, cursor: 'page-2' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            entries: [
              fileMetadata({ id: 'id:book-100', name: 'book-100.epub' }),
              fileMetadata({ id: 'id:book-101', name: 'book-101.epub' }),
            ],
            has_more: false,
          }),
          { status: 200 },
        ),
      );
    const broker = new DropboxCloudFileBroker(CONNECTOR_ID, 'app-key', credentials(), fetchImpl);
    const signal = new AbortController().signal;

    const first = await broker.list({ parentRef: '/novels' }, signal);
    expect(first.items).toHaveLength(100);
    await expect(broker.list({ parentRef: '/other', cursor: first.nextCursor }, signal)).rejects.toThrow('탐색 조건');
    const second = await broker.list({ parentRef: '/novels', cursor: first.nextCursor }, signal);
    expect(second.items).toHaveLength(2);

    const repeatedFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ entries: [], has_more: true, cursor: 'same-cursor' }), { status: 200 }),
      );
    const repeatedBroker = new DropboxCloudFileBroker(CONNECTOR_ID, 'app-key', credentials(), repeatedFetch);
    const repeatedFirst = await repeatedBroker.list({}, signal);
    await expect(repeatedBroker.list({ cursor: repeatedFirst.nextCursor }, signal)).rejects.toThrow('진행되지');
  });

  it('uses search_v2 and its distinct continuation endpoint', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            matches: [{ metadata: { '.tag': 'metadata', metadata: fileMetadata() } }],
            has_more: true,
            cursor: 'search-cursor',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ matches: [], has_more: false, cursor: 'ignored' }), { status: 200 }),
      );
    const broker = new DropboxCloudFileBroker(CONNECTOR_ID, 'app-key', credentials(), fetchImpl);
    const signal = new AbortController().signal;

    const first = await broker.list({ query: 'book' }, signal);
    await expect(broker.list({ query: 'other', cursor: first.nextCursor }, signal)).rejects.toThrow('탐색 조건');
    await broker.list({ query: 'book', cursor: first.nextCursor }, signal);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.dropboxapi.com/2/files/search_v2');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://api.dropboxapi.com/2/files/search/continue_v2');
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({ cursor: 'search-cursor' });
  });

  it('downloads only the selected identity and verified revision/size', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: {
            'Content-Length': String(bytes.byteLength),
            'Dropbox-API-Result': JSON.stringify(fileMetadata({ '.tag': undefined })),
          },
        }),
    );
    const broker = new DropboxCloudFileBroker(CONNECTOR_ID, 'app-key', credentials(), fetchImpl);

    const downloaded = await broker.download(
      {
        key: { connectorId: CONNECTOR_ID, accountConnectionId: 'account-1', remoteId: 'id:book' },
        fileName: 'book.epub',
        byteLength: 4,
        remoteRevision: 'rev-1',
      },
      new AbortController().signal,
    );

    expect(downloaded.remoteRevision).toBe('rev-1');
    expect(downloaded.file).toMatchObject({ name: 'book.epub', size: 4, type: 'application/epub+zip' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://content.dropboxapi.com/2/files/download',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Dropbox-API-Arg': JSON.stringify({ path: 'id:book' }) }),
      }),
    );
  });

  it('refreshes once and retries a request after an early 401', async () => {
    let credential = {
      accessToken: 'stale-token',
      refreshToken: 'refresh-token',
      expiresAt: '2999-01-01T00:00:00.000Z',
      accountId: 'account-1',
    };
    const fetchImpl = vi.fn<typeof fetch>(async (request, init) => {
      const url = String(request);
      if (url.endsWith('/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'fresh-token', expires_in: 14_400 }), { status: 200 });
      }
      const authorization = (init?.headers as Record<string, string>)?.Authorization;
      if (authorization === 'Bearer stale-token') return new Response('', { status: 401 });
      return new Response(JSON.stringify({ entries: [], has_more: false }), { status: 200 });
    });
    const broker = new DropboxCloudFileBroker(
      CONNECTOR_ID,
      'app-key',
      {
        get: async () => credential,
        save: async (next) => {
          credential = next as typeof credential;
        },
      },
      fetchImpl,
    );

    await expect(broker.list({}, new AbortController().signal)).resolves.toEqual({ items: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(credential.accessToken).toBe('fresh-token');
  });

  it('cancels a pending response stream when the caller aborts', async () => {
    let streamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => {
        streamCancelled = true;
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { 'Dropbox-API-Result': JSON.stringify(fileMetadata()) },
        }),
    );
    const broker = new DropboxCloudFileBroker(CONNECTOR_ID, 'app-key', credentials(), fetchImpl);
    const controller = new AbortController();
    const pending = broker.download(
      {
        key: { connectorId: CONNECTOR_ID, accountConnectionId: 'account-1', remoteId: 'id:book' },
        fileName: 'book.epub',
        byteLength: 4,
        remoteRevision: 'rev-1',
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(streamCancelled).toBe(true);
  });

  it('fails closed on changed identity, oversize metadata, abort, and redacts provider error bodies', async () => {
    const identityFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'Dropbox-API-Result': JSON.stringify(fileMetadata({ id: 'id:other' })) },
        }),
    );
    const identityBroker = new DropboxCloudFileBroker(CONNECTOR_ID, 'app-key', credentials(), identityFetch);
    const ref = {
      key: { connectorId: CONNECTOR_ID, accountConnectionId: 'account-1', remoteId: 'id:book' },
      fileName: 'book.epub',
      byteLength: 4,
      remoteRevision: 'rev-1',
    } as const;
    await expect(identityBroker.download(ref, new AbortController().signal)).rejects.toThrow('identity');

    const oversizedFetch = vi.fn();
    const oversizedBroker = new DropboxCloudFileBroker(
      CONNECTOR_ID,
      'app-key',
      credentials(),
      oversizedFetch as typeof fetch,
    );
    await expect(
      oversizedBroker.download(
        { ...ref, byteLength: DROPBOX_EXTERNAL_SOURCE_MAX_DOWNLOAD_BYTES + 1 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('허용된 다운로드 크기');
    expect(oversizedFetch).not.toHaveBeenCalled();

    const aborted = new AbortController();
    aborted.abort();
    await expect(identityBroker.download(ref, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });

    const privateBody = 'private/path/book.epub secret-provider-detail';
    const errorBroker = new DropboxCloudFileBroker(
      CONNECTOR_ID,
      'app-key',
      credentials(),
      vi.fn(async () => new Response(privateBody, { status: 409 })),
    );
    let message = '';
    try {
      await errorBroker.list({}, new AbortController().signal);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('찾을 수 없습니다');
    expect(message).not.toContain(privateBody);
    expect(message).not.toContain('private/path');
  });
});
