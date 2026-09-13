import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { examplePackageManifest } from '../../src/test/extension-package-fixture';
import { buildMoyaExtension } from '../../src/extensions/packages/package-builder';
import { verifyMoyaExtension } from '../../src/extensions/packages/package-archive';
import { IndexedDbPackageInstallStore } from '../../src/extensions/packages/package-install-store';
import { PackageRuntimeCatalog } from '../../src/extensions/packages/package-runtime-catalog';
import { createNodePackageExecution } from '../../apps/server/src/extensions/node-package-execution';
import { createConfiguredContentService } from '../../apps/server/src/extensions/configured-content-service';
import { materializeSourceContent } from '../../apps/server/src/extensions/source-content-service';
import { validateMoyaPackageManifest } from '@noveldesk/extension-contracts/package';
import { validateSourceResult, validateSourceContentRequest } from '@noveldesk/extension-contracts/source-protocol';
import { providerText } from '@noveldesk/extension-contracts/source-sdk';
import { startNativeExtensionHost } from './native-host';
import { NativePackageExecution } from '../../src/platform/tauri/native-package-execution';
import { buildProject, runProjectSource } from './project';
import path from 'node:path';

const sourceId = 'org.example.catalog.source';
const url = 'https://catalog.example/work/one';
const raw = Buffer.from('\ufeff  Preserved\r\n\r\nEnd  \r\n');
const signal = () => new AbortController().signal;
const manifest = () => ({
  ...examplePackageManifest(),
  requestedAccess: {
    networkOrigins: ['https://catalog.example'],
    storageKiB: 0,
    contentServices: [{ sourceId, version: 1, origins: ['https://catalog.example'] }],
  },
});
const source = `globalThis.moyaExtension=async(method,input)=>{
 if(method==='describe')return {apiVersion:1,sources:[{id:'${sourceId}',cover:false}]};
 if(method==='source.getContent')return {kind:'service',service:'text-content',version:1,url:'${url}'};
 return {items:[]};
};`;
async function pkg(signed = false, value = manifest()) {
  const signingKey = signed
    ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    : undefined;
  return verifyMoyaExtension(await buildMoyaExtension({ manifest: value, source, license: 'fixture', signingKey }));
}
async function providerFixture() {
  const calls: string[] = [];
  let pending = false;
  const id = '12345678-1234-1234-1234-123456789abc';
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    expect(request.headers.authorization).toBe('Bearer synthetic-existing-key');
    calls.push(request.url!);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/jobs') {
      expect(JSON.parse(Buffer.concat(chunks).toString()).url).toBe(url);
      response.end(JSON.stringify({ id, kind: 'novel', state: pending ? 'queued' : 'ready' }));
    } else if (request.url?.endsWith('/manifest'))
      response.end(JSON.stringify({ id, kind: 'novel', chapterUrl: url, text: raw.toString('utf8') }));
    else if (request.url?.endsWith('/close')) response.end('{}');
    else response.end(JSON.stringify({ id, kind: 'novel', state: pending ? 'queued' : 'ready' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    calls,
    setPending: () => {
      pending = true;
    },
    endpoint: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const binding = (fingerprint: string) => ({
  ownerId: 'owner',
  packageId: 'org.example.catalog',
  sourceId,
  publisherFingerprint: fingerprint,
  provider: 'default',
  origins: ['https://catalog.example'],
});

describe('optional installed content services', () => {
  it.each([false, true])(
    'downloads direct text without a provider (optional declaration: %s)',
    async (declareService) => {
      const metadata = manifest();
      if (!declareService) metadata.requestedAccess.contentServices = [];
      const value = await verifyMoyaExtension(
        await buildMoyaExtension({
          manifest: metadata,
          license: 'fixture',
          source: `globalThis.moyaExtension=async(method,input,host)=>({
        kind:'text',asset:await host.request('http.request',{
          url:'${url}',response:'asset'
        })
      });`,
        }),
      );
      const transport = vi.fn(async () => ({
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: Readable.from([raw]),
      }));
      // No vault, resolver, provider process, environment binding, or helper health request.
      const execution = createNodePackageExecution('self-host-gateway', {
        transport: { lookup: async () => [{ address: '93.184.216.34', family: 4 }], transport },
      });
      const result = await execution.invoke(
        value,
        'source.getContent',
        { sourceId, workId: 'work', releaseId: 'one' },
        signal(),
      );
      expect(Buffer.from(await [...result.assets.values()][0].arrayBuffer())).toEqual(raw);
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it('pins unsigned development packages to the exact reviewed archive digest', async () => {
    const value = await pkg();
    const f = await providerFixture();
    const approved = { ...binding('unused'), publisherFingerprint: undefined, digest: value.digest };
    const service = createConfiguredContentService(
      {
        CONTENT_PROVIDER_ENDPOINT: f.endpoint,
        CONTENT_PROVIDER_KEY: 'synthetic-existing-key',
        EXTENSION_CONTENT_BINDINGS: JSON.stringify([approved]),
      },
      'owner',
      {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      },
    );
    const scope = { packageId: value.manifest.extension.id, digest: value.digest, sourceId, url, signal: signal() };
    try {
      await expect(service.resolve({ ...scope, digest: '0'.repeat(64) })).rejects.toThrow(
        'source_content_service_required',
      );
      expect(f.calls).toHaveLength(0);
      expect(await service.resolve(scope)).toEqual(raw);
    } finally {
      await service.dispose();
      await f.close();
    }
  });

  it('fences DNS waits and releases bounded provider slots on cancellation', async () => {
    const value = await pkg(true);
    const f = await providerFixture();
    const service = createConfiguredContentService(
      {
        CONTENT_PROVIDER_ENDPOINT: f.endpoint,
        CONTENT_PROVIDER_KEY: 'synthetic-existing-key',
        EXTENSION_CONTENT_BINDINGS: JSON.stringify([binding(value.publisherFingerprint!)]),
      },
      'owner',
      { lookup: async () => new Promise(() => {}) },
    );
    const one = new AbortController();
    const two = new AbortController();
    const scope = {
      packageId: value.manifest.extension.id,
      publisherFingerprint: value.publisherFingerprint,
      digest: value.digest,
      sourceId,
      url,
    };
    try {
      const first = service.resolve({ ...scope, signal: one.signal });
      const second = service.resolve({ ...scope, signal: two.signal });
      const failures = [expect(first).rejects.toThrow('cancelled'), expect(second).rejects.toThrow('cancelled')];
      await expect(service.resolve({ ...scope, signal: signal() })).rejects.toThrow('execution_busy');
      one.abort();
      two.abort();
      await Promise.all(failures);
      await service.dispose();
      expect(f.calls).toHaveLength(0);
    } finally {
      one.abort();
      two.abort();
      await service.dispose();
      await f.close();
    }
  });

  it('builds the SDK provider example and materializes only with an explicit development resolver', async () => {
    const value = await buildProject(path.resolve('packages/extension-runtime/examples/provider-text'));
    const input = { sourceId: 'org.example.provider-text.source', workId: 'work', releaseId: 'one' };
    await expect(runProjectSource(value, 'source.getContent', input)).rejects.toThrow(
      'source_content_service_required',
    );
    const result = await runProjectSource(value, 'source.getContent', input, {
      contentResolver: async (scope) => {
        expect(scope.url).toBe(url);
        return raw;
      },
    });
    expect(result.assets[0].bytes).toEqual(raw);
    await expect(
      runProjectSource(
        value,
        'source.getContent',
        { ...input, workId: 'another' },
        {
          contentResolver: async () => {
            throw new Error('should not be invoked');
          },
        },
      ),
    ).rejects.toThrow();
  });

  it('bounds an uncooperative host job and rejects invalid/oversized UTF-8 without publishing assets', async () => {
    const value = await pkg();
    for (const bytes of [new Uint8Array([255]), Buffer.from('  '), new Uint8Array(2 * 1024 * 1024 + 1)])
      await expect(
        materializeSourceContent(value, sourceId, providerText(url), signal(), async () => bytes),
      ).rejects.toThrow();
    vi.useFakeTimers();
    try {
      let pendingSignal: AbortSignal | undefined;
      const task = materializeSourceContent(value, sourceId, providerText(url), signal(), async (scope) => {
        pendingSignal = scope.signal;
        return new Promise<Uint8Array>(() => {});
      });
      const rejected = expect(task).rejects.toThrow('source_content_service_timeout');
      await vi.advanceTimersByTimeAsync(95001);
      await rejected;
      expect(pendingSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates declarations and keeps intermediate requests out of public content results', () => {
    expect(validateMoyaPackageManifest(manifest()).ok).toBe(true);
    for (const declarations of [
      [{ sourceId, version: 2, origins: ['https://catalog.example'] }],
      [{ sourceId: 'another.source', version: 1, origins: ['https://catalog.example'] }],
      [{ sourceId, version: 1, origins: ['https://other.example'] }],
      [{ sourceId, version: 1, origins: [], endpoint: 'http://private' }],
    ]) {
      expect(
        validateMoyaPackageManifest({
          ...manifest(),
          requestedAccess: { ...manifest().requestedAccess, contentServices: declarations },
        }).ok,
      ).toBe(false);
    }
    expect(validateSourceContentRequest(providerText(url))).toBe(true);
    expect(validateSourceContentRequest({ ...providerText(url), key: 'secret' })).toBe(false);
    expect(validateSourceResult('source.getContent', providerText(url))).toBe(false);
  });

  it('requires a declared, allowed service without invoking a provider for other requests', async () => {
    const value = await pkg();
    let calls = 0;
    const execution = createNodePackageExecution('self-host-gateway', {
      contentResolver: async () => {
        calls++;
        return raw;
      },
    });
    await execution.prepare(value);
    await execution.invoke(value, 'source.listWorks', { sourceId }, signal());
    expect(calls).toBe(0);
    await expect(
      materializeSourceContent(
        value,
        sourceId,
        providerText('https://other.example/chapter'),
        signal(),
        async () => raw,
      ),
    ).rejects.toThrow('source_content_service_denied');
    await expect(materializeSourceContent(value, sourceId, providerText(url), signal())).rejects.toThrow(
      'source_content_service_required',
    );
    await expect(
      materializeSourceContent(value, 'other', providerText(url), signal(), async () => raw),
    ).rejects.toThrow('source_content_service_denied');
    const result = await execution.invoke(
      value,
      'source.getContent',
      { sourceId, workId: 'work', releaseId: 'one' },
      signal(),
    );
    expect(validateSourceResult('source.getContent', result.result)).toBe(true);
    expect(Buffer.from(await [...result.assets.values()][0].arrayBuffer())).toEqual(raw);
    expect(calls).toBe(1);
    expect(JSON.stringify(result.result)).not.toContain(url);
  });

  it('reuses a pinned existing job connection, denies other owners/publishers and closes after cancellation', async () => {
    const value = await pkg(true);
    const f = await providerFixture();
    const env = {
      CONTENT_PROVIDER_ENDPOINT: f.endpoint,
      CONTENT_PROVIDER_KEY: 'synthetic-existing-key',
      EXTENSION_CONTENT_BINDINGS: JSON.stringify([binding(value.publisherFingerprint!)]),
    };
    const service = createConfiguredContentService(env, 'owner', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    const other = createConfiguredContentService(env, 'another-owner');
    const scope = {
      packageId: value.manifest.extension.id,
      digest: value.digest,
      publisherFingerprint: value.publisherFingerprint,
      sourceId,
      url,
      signal: signal(),
    };
    try {
      await expect(other.resolve(scope)).rejects.toThrow('source_content_service_required');
      await expect(service.resolve({ ...scope, publisherFingerprint: '0'.repeat(64) })).rejects.toThrow(
        'source_content_service_required',
      );
      await expect(service.resolve({ ...scope, url: 'https://other.example/one' })).rejects.toThrow(
        'source_content_service_denied',
      );
      expect(f.calls).toHaveLength(0);
      const result = await createNodePackageExecution('self-host-gateway', { contentResolver: service.resolve }).invoke(
        value,
        'source.getContent',
        { sourceId, workId: 'work', releaseId: 'one' },
        signal(),
      );
      expect(Buffer.from(await [...result.assets.values()][0].arrayBuffer())).toEqual(raw);
      expect(f.calls.at(-1)).toMatch(/\/close$/);
      f.setPending();
      const abort = new AbortController();
      const pending = service.resolve({ ...scope, signal: abort.signal });
      const rejected = expect(pending).rejects.toThrow('cancelled');
      for (let n = 0; n < 100 && f.calls.filter((route) => route === '/v1/jobs').length < 2; n++) await delay(10);
      abort.abort();
      await rejected;
      expect(f.calls.filter((route) => route.endsWith('/close'))).toHaveLength(2);
    } finally {
      await service.dispose();
      await other.dispose();
      await f.close();
    }
  });

  it('rejects unsigned bindings/config leaks and a private source address before contacting the provider', async () => {
    expect(() => createConfiguredContentService({ EXTENSION_CONTENT_BINDINGS: '{secret' }, 'owner')).toThrow(
      'invalid_extension_content_configuration',
    );
    expect(() =>
      createConfiguredContentService({ EXTENSION_CONTENT_BINDINGS: JSON.stringify([binding('unsigned')]) }, 'owner'),
    ).toThrow('invalid_extension_content_configuration');
    const value = await pkg(true);
    const f = await providerFixture();
    const service = createConfiguredContentService(
      {
        CONTENT_PROVIDER_ENDPOINT: f.endpoint,
        CONTENT_PROVIDER_KEY: 'synthetic-existing-key',
        EXTENSION_CONTENT_BINDINGS: JSON.stringify([binding(value.publisherFingerprint!)]),
      },
      'owner',
      {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      },
    );
    try {
      await expect(
        service.resolve({
          packageId: value.manifest.extension.id,
          publisherFingerprint: value.publisherFingerprint,
          digest: value.digest,
          sourceId,
          url,
          signal: signal(),
        }),
      ).rejects.toThrow('source_content_service_denied');
      expect(f.calls).toHaveLength(0);
    } finally {
      await service.dispose();
      await f.close();
    }
  });

  it('aborts a removed package service and never accepts its late response', async () => {
    const value = await pkg();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (value: Uint8Array) => void;
    const execution = createNodePackageExecution('self-host-gateway', {
      contentResolver: async () => {
        entered();
        return new Promise<Uint8Array>((resolve) => {
          release = resolve;
        });
      },
    });
    const store = new IndexedDbPackageInstallStore('content-service-race', new IDBFactory());
    const catalog = new PackageRuntimeCatalog(store, execution);
    try {
      const plan = await catalog.installer.inspect(value.archive);
      await catalog.installer.install(plan, { digest: value.digest });
      await catalog.refresh();
      const pending = catalog.invoke(sourceId, 'source.getContent', { workId: 'work', releaseId: 'one' }, signal());
      const rejected = expect(pending).rejects.toThrow();
      await started;
      await catalog.installer.remove(value.manifest.extension.id, 1);
      await catalog.refresh();
      await rejected;
      release(raw);
      expect((await store.read(value.manifest.extension.id))?.active).toBeUndefined();
    } finally {
      catalog.dispose();
      await store.close();
    }
  });

  it('finishes a 31-second host job after guest exit through native binary transport', async () => {
    const value = await pkg();
    const host = await startNativeExtensionHost('b'.repeat(64), 'http://127.0.0.1:5173', {
      contentResolver: async ({ signal }) => {
        await delay(31000, undefined, { signal });
        return raw;
      },
    });
    const execution = new NativePackageExecution(
      async <T>() => ({ endpoint: host.endpoint }) as T,
      (input, init) =>
        fetch(input, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${'b'.repeat(64)}` } }),
    );
    try {
      await execution.prepare(value);
      const result = await execution.invoke(
        value,
        'source.getContent',
        { sourceId, workId: 'work', releaseId: 'one' },
        signal(),
      );
      expect(Buffer.from(await [...result.assets.values()][0].arrayBuffer())).toEqual(raw);
    } finally {
      await host.close();
    }
  }, 45000);
});
