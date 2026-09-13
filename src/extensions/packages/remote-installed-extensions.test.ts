import { describe, expect, it, vi } from 'vitest';
import { RemoteInstalledExtensions } from './remote-installed-extensions';
import { RemoteApiClient } from '../../services/remote/remote-api-client';
import { examplePackageManifest } from '../../test/extension-package-fixture';

function inventory(revision = 1, preparedImageImports?: boolean, preparedDocumentImports?: boolean) {
  const manifest = examplePackageManifest();
  return {
    preparedImageImports,
    preparedDocumentImports,
    packages: [
      {
        id: manifest.extension.id,
        revision,
        enabled: true,
        publisherPin: 'unsigned',
        active: { digest: 'a'.repeat(64), manifest },
        updatedAt: '2026-09-12T00:00:00Z',
      },
    ],
    sources: manifest.extension.contributes.externalSources.map((descriptor) => ({ descriptor })),
    errors: [],
  };
}
const context = { brokers: { get: () => undefined } };
describe('remote package inventory and source client', () => {
  it('uses the server-owned import path only when the server advertises it', async () => {
    const request = vi.fn(async () => inventory());
    const client = new RemoteInstalledExtensions({ request, requestBlob: vi.fn() } as unknown as RemoteApiClient);
    await client.refresh();
    expect(client.getHostedImageImport('org.example.catalog.source')).toBeUndefined();
    expect(client.getHostedDocumentImport('org.example.catalog.source')).toBeUndefined();
    request.mockResolvedValueOnce(inventory(1, true, true));
    await client.refresh();
    expect(client.getHostedImageImport('org.example.catalog.source')).toBeDefined();
    expect(client.getHostedDocumentImport('org.example.catalog.source')).toBeDefined();
    request.mockResolvedValueOnce(inventory());
    await client.refresh();
    expect(client.getHostedImageImport('org.example.catalog.source')).toBeUndefined();
    expect(client.getHostedDocumentImport('org.example.catalog.source')).toBeUndefined();
  });
  it('exposes original APK preferences through the existing authenticated client and refreshes after saving', async () => {
    const snapshot = { revision: 4, fields: [], groups: [], privateOrigins: [], networkPolicy: 'direct' };
    const request = vi.fn(async (path: string) => (path.endsWith('/preferences') ? snapshot : inventory()));
    const client = new RemoteInstalledExtensions({ request, requestBlob: vi.fn() } as unknown as RemoteApiClient);
    expect(await client.apk.preferences!('org.example.apk')).toEqual(snapshot);
    await client.apk.savePreferences!('org.example.apk', 4, { '["1","enabled"]': true }, []);
    expect(request).toHaveBeenCalledWith(
      '/apk-extensions/preferences-save',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          pkg: 'org.example.apk',
          revision: 4,
          values: { '["1","enabled"]': true },
          privateOrigins: [],
        }),
      }),
      120000,
    );
    expect(request).toHaveBeenCalledWith('/extensions/packages');
  });
  it('coalesces requests, keeps unchanged snapshots quiet and preserves known sources during transient failure', async () => {
    const request = vi.fn(async () => inventory());
    const client = new RemoteInstalledExtensions({ request, requestBlob: vi.fn() } as unknown as RemoteApiClient);
    const changed = vi.fn();
    client.subscribe(changed);
    await Promise.all([client.refresh(), client.refresh()]);
    expect(request).toHaveBeenCalledTimes(1);
    const first = client.getSnapshot();
    await client.refresh();
    expect(client.getSnapshot()).toBe(first);
    expect(changed).toHaveBeenCalledTimes(1);
    request.mockRejectedValueOnce(new Error('offline'));
    await client.refresh();
    expect(client.getExternalSourceStatus('org.example.catalog.source').state).toBe('connected');
    expect(client.getSnapshot().error).toBeDefined();
  });
  it('propagates download cancellation and does not publish a cover from a replaced generation', async () => {
    const request = vi.fn(async () => inventory());
    let complete!: (value: { blob: Blob; headers: Headers; status: number }) => void;
    const requestBlob = vi.fn(
      (_path: string, _init?: RequestInit) =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const client = new RemoteInstalledExtensions({ request, requestBlob } as unknown as RemoteApiClient);
    await client.refresh();
    const controller = new AbortController();
    const cover = client.resolveExternalSourceCover(
      'org.example.catalog.source',
      context,
      { connectorId: 'org.example.catalog.source', remoteId: 'work' },
      controller.signal,
    );
    expect(requestBlob.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
    request.mockResolvedValueOnce(inventory(2));
    await client.refresh();
    complete({ blob: new Blob(['image'], { type: 'image/png' }), headers: new Headers(), status: 200 });
    await expect(cover).rejects.toThrow('package_generation_changed');
  });
  it('rejects raw JS as an installation file while preserving the JS authoring workflow', async () => {
    const request = vi.fn();
    const client = new RemoteInstalledExtensions({ request, requestBlob: vi.fn() } as unknown as RemoteApiClient);
    await expect(client.inspect(new File(['code'], 'source.js'))).rejects.toThrow('.moyaext');
    expect(request).not.toHaveBeenCalled();
  });
});
