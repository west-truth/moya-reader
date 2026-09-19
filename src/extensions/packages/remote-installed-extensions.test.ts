import { describe, expect, it, vi } from 'vitest';
import { RemoteInstalledExtensions } from './remote-installed-extensions';
import { RemoteApiClient } from '../../services/remote/remote-api-client';
import { examplePackageManifest } from '../../test/extension-package-fixture';
import type { MoyaPackageManifestV1 } from '@noveldesk/extension-contracts/package';
import { createServer } from 'node:http';

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
function compatibilityInventory(
  review: { pkg: string; version: string; digest: string; revision: number },
  overrides: Partial<{ version: string; digest: string; revision: number }> = {},
) {
  return {
    available: true,
    revision: overrides.revision ?? review.revision + 1,
    packages: [
      {
        pkg: review.pkg,
        version: overrides.version ?? review.version,
        digest: overrides.digest ?? review.digest,
        code: 2,
        sources: [],
      },
    ],
    repositories: [],
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
  it('confirms the installed digest with a fresh inventory without waiting for a stale refresh', async () => {
    let finishStale!: (value: ReturnType<typeof inventory>) => void;
    let inventoryCalls = 0;
    const request = vi.fn((path: string, _init?: RequestInit) => {
      if (path.startsWith('/extensions/packages/install?')) return Promise.resolve({ installed: true });
      inventoryCalls++;
      if (inventoryCalls === 1)
        return new Promise<ReturnType<typeof inventory>>((resolve) => {
          finishStale = resolve;
        });
      return Promise.resolve(inventory());
    });
    const client = new RemoteInstalledExtensions({ request, requestBlob: vi.fn() } as unknown as RemoteApiClient);
    const stale = client.refresh();
    await Promise.resolve();
    const manifest = examplePackageManifest() as MoyaPackageManifestV1;
    const file = new File(['package'], 'source.moyaext');
    await client.install(file, {
      operation: 'install',
      expectedRevision: 0,
      publisherChanged: false,
      expandedAccess: true,
      downgrade: false,
      package: { digest: 'a'.repeat(64), manifest },
    });
    expect(client.getSnapshot().packages[0]?.active?.digest).toBe('a'.repeat(64));
    const installCall = request.mock.calls.find(([path]) => String(path).startsWith('/extensions/packages/install?'));
    expect(installCall?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
    finishStale({ ...inventory(), packages: [], sources: [] });
    await stale;
    expect(client.getSnapshot().packages).toHaveLength(1);
  });
  it('confirms compatibility installs with the caller signal and exact digest/version before resolving', async () => {
    const review = {
      id: 'review',
      revision: 4,
      pkg: 'org.example.mangayomi',
      version: '2.0.0',
      digest: 'b'.repeat(64),
      signers: [],
    };
    const request = vi.fn(async (path: string) =>
      path === '/mangayomi-extensions' ? compatibilityInventory(review) : { installed: true },
    );
    const client = new RemoteInstalledExtensions({ request, requestBlob: vi.fn() } as unknown as RemoteApiClient);
    const controller = new AbortController();
    await expect(client.mangayomi.install(review, controller.signal)).resolves.toMatchObject({ revision: 5 });
    expect(request).toHaveBeenCalledWith('/mangayomi-extensions', { signal: expect.any(AbortSignal) }, 30000);
    const mismatched = vi.fn(async (path: string) =>
      path === '/mangayomi-extensions'
        ? compatibilityInventory(review, { digest: 'c'.repeat(64) })
        : { installed: true },
    );
    const mismatchClient = new RemoteInstalledExtensions({
      request: mismatched,
      requestBlob: vi.fn(),
    } as unknown as RemoteApiClient);
    await expect(mismatchClient.mangayomi.install(review, controller.signal)).rejects.toThrow(
      'apk_install_unconfirmed',
    );
  });
  it('aborts a compatibility confirmation whose real HTTP body stalls after headers', async () => {
    const review = {
      id: 'review',
      revision: 4,
      pkg: 'org.example.mangayomi',
      version: '2.0.0',
      digest: 'b'.repeat(64),
      signers: [],
    };
    let confirmationClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      confirmationClosed = resolve;
    });
    const server = createServer((request, response) => {
      if (request.method === 'POST') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"installed":true}');
        return;
      }
      request.once('close', confirmationClosed);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"available":true');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    const api = new RemoteApiClient(`http://127.0.0.1:${address.port}`);
    const client = new RemoteInstalledExtensions(api, { operationMs: 500, confirmationMs: 25 });
    try {
      await expect(client.mangayomi.install(review)).rejects.toThrow('apk_install_unconfirmed');
      await closed;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
