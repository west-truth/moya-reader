import { describe, expect, it, vi } from 'vitest';
import { DropboxCloudVaultProvider, type DropboxCredential } from './dropbox-provider';

describe('Dropbox cloud vault provider', () => {
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
});
