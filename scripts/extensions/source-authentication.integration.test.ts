import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  validateMoyaPackageManifest,
  type SourceAuthentication,
  type SourceAuthenticationRequest,
} from '@noveldesk/extension-contracts/package';
import { examplePackageManifest } from '../../src/test/extension-package-fixture';
import { buildMoyaExtension } from '../../src/extensions/packages/package-builder';
import { verifyMoyaExtension } from '../../src/extensions/packages/package-archive';
import { IndexedDbPackageInstallStore } from '../../src/extensions/packages/package-install-store';
import { PackageRuntimeCatalog } from '../../src/extensions/packages/package-runtime-catalog';
import { createNodePackageExecution } from '../../apps/server/src/extensions/node-package-execution';
import { EncryptedSourceCredentialVault } from '../../apps/server/src/extensions/source-credential-vault';
import {
  createSourceAuthentication,
  type SourceTransport,
} from '../../apps/server/src/extensions/source-authentication';
import { startNativeExtensionHost } from './native-host';
import { NativePackageExecution } from '../../src/platform/tauri/native-package-execution';
import { LocalInstalledExtensions } from '../../src/extensions/packages/local-installed-extensions';

const sourceId = 'org.example.catalog.source';
const auth: SourceAuthentication = {
  sourceId,
  label: '예제 계정',
  origin: 'https://catalog.example',
  scheme: 'cookie',
  cookieName: 'SESSION',
  verification: { path: '/account', field: ['account', 'authenticated'], equals: true },
};
const manifest = () => {
  const value = examplePackageManifest();
  return {
    ...value,
    requestedAccess: {
      ...value.requestedAccess,
      networkOrigins: [auth.origin, 'https://cdn.example'],
      authentication: [auth],
    },
  };
};
const source = `globalThis.moyaExtension=async(method,input,host)=>{
 if(method==='describe') return {apiVersion:1,sources:[{id:'${sourceId}',cover:false}]};
 if(method==='source.getContent')return {kind:'text',asset:await host.request('http.request',{url:'${auth.origin}/content',response:'asset',authenticated:true})};
 return {items:JSON.parse((await host.request('http.request',{url:'${auth.origin}/works',response:'text',authenticated:true})).text)};
};`;
const signal = () => new AbortController().signal;
const save = (secret = 'fixture-session'): SourceAuthenticationRequest => ({ action: 'save', credential: { secret } });
const raw = Buffer.from('첫 줄\r\n\r\n  원문 공백\n');
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'moya-extension-auth-'));
  const key = randomBytes(32);
  const vault = new EncryptedSourceCredentialVault(directory, key);
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const transport: SourceTransport = {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async ({ url }, input) => {
      requests.push({ url: url.href, headers: input.headers });
      const session = input.headers.cookie;
      const status = session === 'SESSION=forbidden' ? 403 : session === 'SESSION=expired' ? 401 : 200;
      const body =
        url.pathname === '/content'
          ? raw
          : Buffer.from(
              JSON.stringify(
                url.pathname === '/account'
                  ? { account: { authenticated: session === 'SESSION=fixture-session' } }
                  : [{ id: 'work', title: '작품' }],
              ),
            );
      return { status, headers: { 'content-type': 'text/plain' }, body: Readable.from([body]) };
    },
  };
  return {
    directory,
    key,
    vault,
    requests,
    transport,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
async function pkg() {
  return verifyMoyaExtension(await buildMoyaExtension({ manifest: manifest(), source, license: 'fixture' }));
}

describe('installed source authentication', () => {
  it('checks a repository through native execution and reviews before installing through the device manager', async () => {
    const f = fixture();
    const value = { ...manifest(), updates: { repository: 'https://catalog.example/index.json' } };
    const original = await buildMoyaExtension({ manifest: value, source, license: 'fixture' });
    value.extension.version = '1.0.1';
    const candidate = await verifyMoyaExtension(
      await buildMoyaExtension({ manifest: value, source, license: 'fixture' }),
    );
    const transport: SourceTransport = {
      ...f.transport,
      transport: async ({ url }) => ({
        status: 200,
        headers: {},
        body: Readable.from([
          url.pathname === '/index.json'
            ? Buffer.from(
                JSON.stringify({
                  format: 'moya.extension.repository',
                  version: 1,
                  packages: [
                    { id: value.extension.id, version: '1.0.1', archive: './next.moyaext', sha256: candidate.digest },
                  ],
                }),
              )
            : Buffer.from(await candidate.archive.arrayBuffer()),
        ]),
      }),
    };
    const host = await startNativeExtensionHost('a'.repeat(64), 'http://127.0.0.1:5173', { vault: f.vault, transport });
    const execution = new NativePackageExecution(
      async <T>() => ({ endpoint: host.endpoint }) as T,
      (input, init) =>
        fetch(input, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${'a'.repeat(64)}` } }),
    );
    const store = new IndexedDbPackageInstallStore('native-repository', new IDBFactory());
    const manager = new LocalInstalledExtensions(execution, store);
    try {
      const file = new File([original], 'source.moyaext');
      await manager.install(file, await manager.inspect(file));
      const review = await manager.checkUpdate(value.extension.id, 1);
      expect(review?.plan.operation).toBe('update');
      expect((await store.read(value.extension.id))?.revision).toBe(1);
      await manager.install(review!.file, review!.plan);
      expect((await store.read(value.extension.id))?.active?.digest).toBe(candidate.digest);
      expect(await manager.checkUpdate(value.extension.id, 2)).toBeUndefined();
      const saved = await manager.refreshRepository(value.updates.repository);
      expect(saved.index?.packages[0].sha256).toBe(candidate.digest);
      await store.close();
      expect(await manager.listRepositories()).toHaveLength(1);
      const selected = await manager.selectRepositoryPackage(saved.url, value.extension.id, candidate.digest);
      expect(selected.plan.operation).toBe('unchanged');
      await manager.removeRepository(saved.url, saved.revision);
      expect(await manager.listRepositories()).toEqual([]);
      expect((await store.read(value.extension.id))?.active?.digest).toBe(candidate.digest);
    } finally {
      manager.dispose();
      await host.close();
      await store.close();
      f.cleanup();
    }
  });
  it('supports Basic and Bearer while isolating another source and a changed authentication recipe', async () => {
    const f = fixture();
    const p = await pkg();
    try {
      for (const scheme of ['basic', 'bearer'] as const) {
        const credential = scheme === 'basic' ? { username: 'reader', secret: 'password' } : { secret: 'token' };
        const expected =
          scheme === 'basic' ? `Basic ${Buffer.from('reader:password').toString('base64')}` : 'Bearer token';
        const config: SourceAuthentication = { ...auth, scheme, cookieName: undefined };
        const customized = {
          ...p,
          manifest: { ...p.manifest, requestedAccess: { ...p.manifest.requestedAccess, authentication: [config] } },
        };
        const service = createSourceAuthentication(f.vault, {
          ...f.transport,
          transport: async (_url, input) => ({
            status: 200,
            headers: {},
            body: Readable.from([
              Buffer.from(JSON.stringify({ account: { authenticated: input.headers.authorization === expected } })),
            ]),
          }),
        });
        expect(
          await service.manage(customized, sourceId, 'epoch', { action: 'save', credential }, signal()),
        ).toMatchObject({ state: 'valid' });
        expect(
          await service.transport(customized, sourceId, 'epoch').authenticate!(new URL(auth.origin), signal()),
        ).toEqual({ authorization: expected });
        const otherSource = {
          ...customized,
          manifest: {
            ...customized.manifest,
            requestedAccess: {
              ...customized.manifest.requestedAccess,
              authentication: [{ ...config, sourceId: `${sourceId}.other` }],
            },
          },
        };
        expect(await service.manage(otherSource, `${sourceId}.other`, 'epoch', { action: 'status' }, signal())).toEqual(
          { state: 'missing' },
        );
        expect(await service.manage(p, sourceId, 'epoch', { action: 'status' }, signal())).toEqual({
          state: 'missing',
        });
      }
    } finally {
      f.cleanup();
    }
  });
  it('validates source ownership, exact origins, verification and header injection declarations', () => {
    expect(validateMoyaPackageManifest(manifest()).ok).toBe(true);
    for (const change of [
      { sourceId: 'other.source' },
      { origin: 'https://other.example' },
      { cookieName: 'SESSION\r\nInjected' },
      { verification: { ...auth.verification, path: '//other.example/account' } },
      { verification: { ...auth.verification, field: [] } },
    ]) {
      const value = manifest();
      value.requestedAccess.authentication = [{ ...auth, ...change }];
      expect(validateMoyaPackageManifest(value).ok).toBe(false);
    }
  });

  it('verifies before replacement, encrypts persisted sessions and keeps saved distinct from verified', async () => {
    const f = fixture();
    const p = await pkg();
    const service = createSourceAuthentication(f.vault, f.transport);
    const manage = (request: SourceAuthenticationRequest) => service.manage(p, sourceId, 'epoch', request, signal());
    try {
      expect(await manage({ action: 'status' })).toEqual({ state: 'missing' });
      expect(await manage(save('wrong'))).toEqual({ state: 'invalid' });
      expect(readdirSync(f.directory)).toHaveLength(0);
      expect(await manage(save())).toMatchObject({ state: 'valid' });
      expect(
        readFileSync(path.join(f.directory, readdirSync(f.directory)[0])).includes(Buffer.from('fixture-session')),
      ).toBe(false);
      expect(await manage(save('expired'))).toEqual({ state: 'invalid' });
      expect(await manage(save('forbidden'))).toEqual({ state: 'forbidden' });
      expect(await manage({ action: 'check' })).toMatchObject({ state: 'valid' });
      const restored = createSourceAuthentication(new EncryptedSourceCredentialVault(f.directory, f.key), f.transport);
      expect(await restored.manage(p, sourceId, 'epoch', { action: 'status' }, signal())).toEqual({ state: 'saved' });
      expect(await restored.manage(p, sourceId, 'different-epoch', { action: 'status' }, signal())).toEqual({
        state: 'missing',
      });
      expect(
        await service.manage(
          { ...p, publisherFingerprint: 'other' },
          sourceId,
          'epoch',
          { action: 'status' },
          signal(),
        ),
      ).toEqual({ state: 'missing' });
      expect(await manage({ action: 'remove' })).toEqual({ state: 'missing' });
      expect(readdirSync(f.directory)).toHaveLength(0);
    } finally {
      f.cleanup();
    }
  });

  it('injects only in the bound source origin, denies redirects and never sends credentials to the guest', async () => {
    const f = fixture();
    const p = await pkg();
    const execution = createNodePackageExecution('self-host-gateway', { vault: f.vault, transport: f.transport });
    try {
      await expect(execution.invoke(p, 'source.listWorks', { sourceId }, signal(), undefined, 'epoch')).rejects.toThrow(
        'source_auth_required',
      );
      await execution.authenticate!(p, sourceId, 'epoch', save(), signal());
      const result = await execution.invoke(p, 'source.listWorks', { sourceId }, signal(), undefined, 'epoch');
      expect(JSON.stringify(result.result)).not.toContain('fixture-session');
      expect(result.result).toMatchObject({ items: [{ title: '작품' }] });
      const downloaded = await execution.invoke(
        p,
        'source.getContent',
        { sourceId, workId: 'work', releaseId: 'one' },
        signal(),
        undefined,
        'epoch',
      );
      expect(Buffer.from(await [...downloaded.assets.values()][0].arrayBuffer())).toEqual(raw);
      const binding = createSourceAuthentication(f.vault, f.transport).transport(p, sourceId, 'epoch');
      await expect(binding.authenticate!(new URL('https://cdn.example/image'), signal())).rejects.toThrow(
        'source_url_denied',
      );
      const redirecting = createNodePackageExecution('self-host-gateway', {
        vault: f.vault,
        transport: {
          ...f.transport,
          transport: async () => ({
            status: 302,
            headers: { location: 'https://cdn.example/steal' },
            body: Readable.from([]),
          }),
        },
      });
      await expect(
        redirecting.invoke(p, 'source.listWorks', { sourceId }, signal(), undefined, 'epoch'),
      ).rejects.toThrow();
    } finally {
      f.cleanup();
    }
  });

  it('preserves connections on ordinary updates but isolates reinstall and fences disabled work', async () => {
    const f = fixture();
    const store = new IndexedDbPackageInstallStore('auth-lifecycle', new IDBFactory());
    const catalog = new PackageRuntimeCatalog(
      store,
      createNodePackageExecution('self-host-gateway', { vault: f.vault, transport: f.transport }),
    );
    try {
      const p = await pkg();
      const plan = await catalog.installer.inspect(p.archive);
      await catalog.installer.install(plan, { digest: plan.package.digest });
      await catalog.refresh();
      expect(await catalog.authenticate(sourceId, save())).toMatchObject({ state: 'valid' });
      const next = manifest();
      next.extension.version = '1.0.1';
      const updated = await catalog.installer.inspect(
        await buildMoyaExtension({ manifest: next, source, license: 'fixture' }),
      );
      await catalog.installer.install(updated, { digest: updated.package.digest });
      await catalog.refresh();
      expect(await catalog.authenticate(sourceId, { action: 'status' })).toEqual({ state: 'saved' });
      await catalog.installer.setEnabled(p.manifest.extension.id, 2, false);
      await catalog.refresh();
      await expect(catalog.authenticate(sourceId, save())).rejects.toThrow('source_auth_unavailable');
      await catalog.installer.remove(p.manifest.extension.id, 3);
      await catalog.refresh();
      expect(readdirSync(f.directory)).toHaveLength(0);
      const again = await catalog.installer.inspect(p.archive);
      await catalog.installer.install(again, { digest: p.digest });
      expect(await catalog.authenticate(sourceId, { action: 'status' })).toEqual({ state: 'missing' });
    } finally {
      catalog.dispose();
      await store.close();
      f.cleanup();
    }
  });

  it('joins abort and a later logout prevents an in-flight verification from restoring the connection', async () => {
    const f = fixture();
    const p = await pkg();
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const service = createSourceAuthentication(f.vault, {
      ...f.transport,
      transport: async (_url, _request, abort) => {
        reached();
        await new Promise<void>((_resolve, reject) =>
          abort.addEventListener('abort', () => reject(abort.reason), { once: true }),
        );
        throw new Error();
      },
    });
    try {
      const pending = service.manage(p, sourceId, 'epoch', save(), signal());
      const rejected = expect(pending).rejects.toThrow();
      await entered;
      await service.manage(p, sourceId, 'epoch', { action: 'remove' }, signal());
      await rejected;
      expect(readdirSync(f.directory)).toHaveLength(0);
    } finally {
      f.cleanup();
    }
  });

  it('uses the real native HTTP transport, recovers preparation and restores encrypted credentials after host restart', async () => {
    const f = fixture();
    let host = await startNativeExtensionHost('a'.repeat(64), 'http://127.0.0.1:5173', {
      vault: f.vault,
      transport: f.transport,
    });
    const fetcher: typeof fetch = (input, init) =>
      fetch(input, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${'a'.repeat(64)}` } });
    const execution = new NativePackageExecution(async <T>() => ({ endpoint: host.endpoint }) as T, fetcher);
    try {
      const p = await pkg();
      expect(await execution.authenticate(p, sourceId, 'epoch', save(), signal())).toMatchObject({ state: 'valid' });
      await host.close();
      host = await startNativeExtensionHost('a'.repeat(64), 'http://127.0.0.1:5173', {
        vault: new EncryptedSourceCredentialVault(f.directory, f.key),
        transport: f.transport,
      });
      expect(await execution.authenticate(p, sourceId, 'epoch', { action: 'status' }, signal())).toEqual({
        state: 'saved',
      });
      expect(
        (await execution.invoke(p, 'source.listWorks', { sourceId }, signal(), undefined, 'epoch')).result,
      ).toMatchObject({ items: [{ title: '작품' }] });
    } finally {
      await host.close();
      f.cleanup();
    }
  });
});
