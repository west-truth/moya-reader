import { Readable } from 'node:stream';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { validateMoyaPackageManifest } from '@noveldesk/extension-contracts/package';
import { examplePackageManifest } from '../../../../src/test/extension-package-fixture';
import { buildMoyaExtension } from '../../../../src/extensions/packages/package-builder';
import { verifyMoyaExtension } from '../../../../src/extensions/packages/package-archive';
import { IndexedDbPackageInstallStore } from '../../../../src/extensions/packages/package-install-store';
import { PackageRuntimeCatalog } from '../../../../src/extensions/packages/package-runtime-catalog';
import { downloadPackageUpdate } from './package-repository';
import { createNodePackageExecution } from './node-package-execution';
import type { SourceTransport } from './source-authentication';
import { registerExtensionPackageRoutes } from '../routes/extension-packages';
import { registerAuthHook } from '../auth';
import type { ServerConfig } from '../config';

const repository = 'https://catalog.example/extensions/index.json';
const source = `globalThis.moyaExtension=async()=>({apiVersion:1,sources:[{id:'org.example.catalog.source',cover:false}]});`;
const signal = () => new AbortController().signal;
async function fixture() {
  const signingKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const manifest = { ...examplePackageManifest(), updates: { repository } };
  const initial = await verifyMoyaExtension(
    await buildMoyaExtension({ manifest, source, license: 'fixture', signingKey }),
  );
  const nextManifest = { ...manifest, extension: { ...manifest.extension, version: '1.1.0' } };
  const next = await verifyMoyaExtension(
    await buildMoyaExtension({ manifest: nextManifest, source, license: 'fixture', signingKey }),
  );
  const entry = {
    id: manifest.extension.id,
    version: '1.1.0',
    archive: './catalog-1.1.0.moyaext',
    sha256: next.digest,
  };
  let index: unknown = { format: 'moya.extension.repository', version: 1, packages: [entry] };
  let archive = next.archive;
  const calls: string[] = [];
  const transport: SourceTransport = {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    authenticate: async () => {
      throw new Error('repository must never authenticate');
    },
    transport: async ({ url }, request) => {
      calls.push(url.href);
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
      return {
        status: 200,
        headers: {},
        body: Readable.from([
          url.href === repository ? Buffer.from(JSON.stringify(index)) : Buffer.from(await archive.arrayBuffer()),
        ]),
      };
    },
  };
  return {
    initial,
    next,
    nextManifest,
    signingKey,
    entry,
    calls,
    transport,
    setIndex: (value: unknown) => {
      index = value;
    },
    setArchive: (value: Blob) => {
      archive = value;
    },
  };
}
const indexOf = (entry: unknown) => ({ format: 'moya.extension.repository', version: 1, packages: [entry] });

describe('repository updates through the verified installer', () => {
  it('rejects unsafe manifest addresses and malformed index identities', async () => {
    const f = await fixture();
    for (const url of [
      'http://catalog.example/index',
      'https://user:password@catalog.example/index',
      'https://catalog.example/index#fragment',
      'https://localhost/index',
    ])
      expect(validateMoyaPackageManifest({ ...f.initial.manifest, updates: { repository: url } }).ok).toBe(false);
    for (const value of [
      {},
      { ...indexOf(f.entry), packages: [f.entry, f.entry] },
      indexOf({ ...f.entry, version: 'wat' }),
      indexOf({ ...f.entry, sha256: 'wrong' }),
    ]) {
      f.setIndex(value);
      await expect(downloadPackageUpdate(f.initial, signal(), f.transport)).rejects.toThrow(
        'invalid_package_repository',
      );
    }
  });

  it('downloads pinned bytes without source authentication and does not activate before review', async () => {
    const f = await fixture();
    const store = new IndexedDbPackageInstallStore('repo-review', new IDBFactory());
    const execution = createNodePackageExecution('self-host-gateway', { transport: f.transport });
    const prepare = vi.spyOn(execution, 'prepare');
    const catalog = new PackageRuntimeCatalog(store, execution);
    try {
      const install = await catalog.installer.inspect(f.initial.archive);
      await catalog.installer.install(install, { digest: f.initial.digest });
      prepare.mockClear();
      const archive = await catalog.checkUpdate(f.initial.manifest.extension.id, 1, signal());
      expect((await verifyMoyaExtension(archive!)).digest).toBe(f.next.digest);
      expect(prepare).not.toHaveBeenCalled();
      expect((await store.read(f.initial.manifest.extension.id))?.active?.digest).toBe(f.initial.digest);
      const review = await catalog.installer.inspect(archive!);
      expect(review.operation).toBe('update');
      await catalog.installer.install(review, { digest: review.package.digest });
      expect((await store.read(f.initial.manifest.extension.id))?.active?.digest).toBe(f.next.digest);
      expect(await catalog.checkUpdate(f.initial.manifest.extension.id, 2)).toBeUndefined();
      expect(f.calls.filter((url) => url.endsWith('.moyaext'))).toHaveLength(1);
    } finally {
      catalog.dispose();
      await store.close();
    }
  });

  it('blocks wrong hashes, package/version substitution and publisher replacement', async () => {
    const f = await fixture();
    f.setIndex(indexOf({ ...f.entry, sha256: '0'.repeat(64) }));
    await expect(downloadPackageUpdate(f.initial, signal(), f.transport)).rejects.toThrow(
      'package_repository_integrity',
    );
    const variants = [
      { ...f.nextManifest, extension: { ...f.nextManifest.extension, version: '1.2.0' } },
      {
        ...f.nextManifest,
        extension: {
          ...f.nextManifest.extension,
          id: 'org.example',
          contributes: f.nextManifest.extension.contributes,
        },
      },
    ];
    for (const manifest of variants) {
      const other = await verifyMoyaExtension(
        await buildMoyaExtension({ manifest, source, license: 'fixture', signingKey: f.signingKey }),
      );
      f.setArchive(other.archive);
      f.setIndex(indexOf({ ...f.entry, sha256: other.digest }));
      await expect(downloadPackageUpdate(f.initial, signal(), f.transport)).rejects.toThrow(
        'package_repository_integrity',
      );
    }
    const unsigned = await verifyMoyaExtension(
      await buildMoyaExtension({ manifest: f.nextManifest, source, license: 'fixture' }),
    );
    f.setArchive(unsigned.archive);
    f.setIndex(indexOf({ ...f.entry, sha256: unsigned.digest }));
    await expect(downloadPackageUpdate(f.initial, signal(), f.transport)).rejects.toThrow(
      'package_update_publisher_mismatch',
    );
  });

  it('ignores older releases and rejects cross-origin or private-address archive routes', async () => {
    const f = await fixture();
    f.setIndex(indexOf({ ...f.entry, version: '0.9.0' }));
    expect(await downloadPackageUpdate(f.initial, signal(), f.transport)).toBeUndefined();
    expect(f.calls).toHaveLength(1);
    f.setIndex(indexOf({ ...f.entry, archive: 'https://other.example/file.moyaext' }));
    await expect(downloadPackageUpdate(f.initial, signal(), f.transport)).rejects.toThrow(
      'package_repository_origin_denied',
    );
    await expect(
      downloadPackageUpdate(f.initial, signal(), {
        ...f.transport,
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    ).rejects.toThrow('source_address_denied');
  });

  it('keeps repository API behind Moya authentication, checks install revision and returns only a candidate', async () => {
    const f = await fixture();
    const store = new IndexedDbPackageInstallStore('repo-api', new IDBFactory());
    const execution = createNodePackageExecution('self-host-gateway', { transport: f.transport });
    const installer = new PackageRuntimeCatalog(store, execution).installer;
    const plan = await installer.inspect(f.initial.archive);
    await installer.install(plan, { digest: f.initial.digest });
    const app = Fastify();
    await registerAuthHook(app, { host: '127.0.0.1', authToken: 'fixture-token' } as ServerConfig);
    await registerExtensionPackageRoutes(app, store, execution);
    const url = `/api/extensions/packages/${f.initial.manifest.extension.id}/update`;
    try {
      expect((await app.inject({ method: 'POST', url, payload: { revision: 1 } })).statusCode).toBe(401);
      const headers = { authorization: 'Bearer fixture-token' };
      expect((await app.inject({ method: 'POST', url, headers, payload: { revision: 0 } })).statusCode).toBe(409);
      const response = await app.inject({ method: 'POST', url, headers, payload: { revision: 1 } });
      expect(response.statusCode).toBe(200);
      expect((await verifyMoyaExtension(new Blob([Uint8Array.from(response.rawPayload)]))).digest).toBe(f.next.digest);
      expect((await store.read(f.initial.manifest.extension.id))?.revision).toBe(1);
      f.setIndex(indexOf({ ...f.entry, version: '1.0.0' }));
      expect((await app.inject({ method: 'POST', url, headers, payload: { revision: 1 } })).statusCode).toBe(204);
    } finally {
      await app.close();
      await store.close();
    }
  });

  it('cancellation destroys an index body that stalls after headers', async () => {
    const f = await fixture();
    const abort = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const body = new Readable({ read() {} });
    const pending = downloadPackageUpdate(f.initial, abort.signal, {
      ...f.transport,
      transport: async () => {
        entered();
        return { status: 200, headers: {}, body };
      },
    });
    const failure = expect(pending).rejects.toThrow();
    await ready;
    abort.abort();
    await failure;
    expect(body.destroyed).toBe(true);
  });
});
