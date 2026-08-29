import { describe, expect, it, vi } from 'vitest';
import {
  DropboxAccessTokenManager,
  DropboxCloudVaultProvider,
  exchangeDropboxAuthorizationCode,
  type DropboxCredential,
} from './dropbox-provider';

describe('Dropbox cloud vault provider', () => {
  it('requires a stable Dropbox account identity during authorization', async () => {
    await expect(
      exchangeDropboxAuthorizationCode({
        appKey: 'app-key',
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: 'https://reader.example/',
        fetchImpl: vi.fn(
          async () => new Response(JSON.stringify({ access_token: 'token', expires_in: 14_400 }), { status: 200 }),
        ),
      }),
    ).rejects.toThrow('account identity');
  });

  it('reads the app-folder vault and carries the Dropbox revision', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Dropbox-API-Result': JSON.stringify({ rev: 'rev-1' }) },
        }),
    );
    const provider = new DropboxCloudVaultProvider(
      'app-key',
      { get: async () => ({ accessToken: 'token' }), save: async () => undefined },
      fetchImpl as typeof fetch,
    );
    await expect(provider.read()).resolves.toEqual({ bytes: new Uint8Array([1, 2, 3]), revision: 'rev-1' });
  });

  it('checks the vault revision without downloading its contents', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ rev: 'rev-2', size: 123 }), { status: 200 }));
    const provider = new DropboxCloudVaultProvider(
      'app-key',
      { get: async () => ({ accessToken: 'token' }), save: async () => undefined },
      fetchImpl as typeof fetch,
    );

    await expect(provider.getRevision()).resolves.toBe('rev-2');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.dropboxapi.com/2/files/get_metadata',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('refreshes an expired access token before uploading with revision CAS', async () => {
    let saved: DropboxCredential | undefined;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'fresh', expires_in: 14_400 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ rev: 'rev-2' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const provider = new DropboxCloudVaultProvider(
      'app-key',
      {
        get: async () => ({
          accessToken: 'expired',
          refreshToken: 'refresh',
          expiresAt: '2000-01-01T00:00:00.000Z',
        }),
        save: async (credential) => {
          saved = credential;
        },
      },
      fetchImpl,
    );

    await expect(provider.write(new Uint8Array([4]), 'rev-1')).resolves.toEqual({ revision: 'rev-2' });
    expect(saved?.accessToken).toBe('fresh');
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer fresh' });
  });

  it('shares one token refresh across concurrent Dropbox callers', async () => {
    let releaseRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await refreshStarted;
      return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 14_400 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const save = vi.fn(async () => undefined);
    const manager = new DropboxAccessTokenManager(
      'app-key',
      {
        get: async () => ({
          accessToken: 'expired',
          refreshToken: 'refresh',
          expiresAt: '2000-01-01T00:00:00.000Z',
        }),
        save,
      },
      fetchImpl,
    );

    const first = manager.getAccessToken();
    const second = manager.getAccessToken();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual(['fresh', 'fresh']);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('shares one forced refresh after concurrent early unauthorized responses', async () => {
    let credential: DropboxCredential = {
      accessToken: 'stale',
      refreshToken: 'refresh',
      expiresAt: '2999-01-01T00:00:00.000Z',
    };
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await refreshGate;
      return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 14_400 }), { status: 200 });
    });
    const manager = new DropboxAccessTokenManager(
      'app-key',
      {
        get: async () => credential,
        save: async (next) => {
          credential = next;
        },
      },
      fetchImpl,
    );

    const first = manager.refreshAccessToken('stale');
    const second = manager.refreshAccessToken('stale');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual(['fresh', 'fresh']);
    expect(credential.accessToken).toBe('fresh');
  });

  it('does not include Dropbox response bodies in vault errors', async () => {
    const provider = new DropboxCloudVaultProvider(
      'app-key',
      { get: async () => ({ accessToken: 'token' }), save: async () => undefined },
      vi.fn(async () => new Response('private/path secret-provider-detail', { status: 403 })),
    );

    let message = '';
    try {
      await provider.read();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Dropbox vault read failed (403).');
    expect(message).not.toContain('private/path');
  });

  it('stores content-addressed objects without overwriting an existing object', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error_summary: 'path/not_found/' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ metadata: { id: 'folder-content' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ metadata: { id: 'folder-v1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ metadata: { id: 'folder-sha256' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ rev: 'object-rev', size: 4 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const provider = new DropboxCloudVaultProvider(
      'app-key',
      { get: async () => ({ accessToken: 'token' }), save: async () => undefined },
      fetchImpl,
    );

    await expect(
      provider.putObject(
        'content/v1/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        new Blob(['test']),
        { byteLength: 4 },
      ),
    ).resolves.toEqual({ created: true, revision: 'object-rev' });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.dropboxapi.com/2/files/get_metadata');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://api.dropboxapi.com/2/files/create_folder_v2');
    expect(fetchImpl.mock.calls[4]?.[0]).toBe('https://content.dropboxapi.com/2/files/upload');
    expect(fetchImpl.mock.calls[4]?.[1]?.headers).toMatchObject({
      'Dropbox-API-Arg': expect.stringContaining('content/v1/sha256/aaaaaaaa'),
    });
  });

  it('uses an upload session for a large content-addressed object', async () => {
    const size = 141 * 1024 * 1024;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/files/get_metadata')) {
        return new Response(JSON.stringify({ error_summary: 'path/not_found/' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/files/upload_session/start')) {
        return new Response(JSON.stringify({ session_id: 'upload-session' }), { status: 200 });
      }
      if (url.endsWith('/files/upload_session/finish')) {
        return new Response(JSON.stringify({ rev: 'large-rev', size }), { status: 200 });
      }
      return new Response('', { status: 200 });
    });
    const largeBlob = {
      size,
      slice: vi.fn(() => new Blob(['chunk'])),
    } as unknown as Blob;
    const provider = new DropboxCloudVaultProvider(
      'app-key',
      { get: async () => ({ accessToken: 'token' }), save: async () => undefined },
      fetchImpl,
    );
    const objectKey = `content/v1/sha256/${'b'.repeat(64)}`;

    await expect(provider.putObject(objectKey, largeBlob, { byteLength: size })).resolves.toEqual({
      created: true,
      revision: 'large-rev',
    });

    const uploadCalls = fetchImpl.mock.calls.filter((call) => String(call[0]).includes('/files/upload_session/'));
    expect(uploadCalls.at(0)?.[0]).toBe('https://content.dropboxapi.com/2/files/upload_session/start');
    expect(uploadCalls.at(-1)?.[0]).toBe('https://content.dropboxapi.com/2/files/upload_session/finish');
    expect(uploadCalls.filter((call) => String(call[0]).endsWith('/append_v2'))).toHaveLength(16);
    expect(uploadCalls[1]?.[1]?.headers).toMatchObject({
      'Dropbox-API-Arg': JSON.stringify({
        cursor: { session_id: 'upload-session', offset: 8 * 1024 * 1024 },
        close: false,
      }),
    });
    expect(uploadCalls.at(-1)?.[1]?.headers).toMatchObject({
      'Dropbox-API-Arg': expect.stringContaining('"offset":142606336'),
    });
  });
});
