import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { startNativeExtensionHost } from './native-host';
import { NativePackageExecution, decodeNativeAssets } from '../../src/platform/tauri/native-package-execution';
import { LocalInstalledExtensions } from '../../src/extensions/packages/local-installed-extensions';
import { IndexedDbPackageInstallStore } from '../../src/extensions/packages/package-install-store';
import { buildMoyaExtension } from '../../src/extensions/packages/package-builder';
import { examplePackageManifest } from '../../src/test/extension-package-fixture';

describe('native extension host and device manager', () => {
  it('round-trips source options through the native manager and masks secrets while guest reads saved values', async () => {
    let host: Awaited<ReturnType<typeof startNativeExtensionHost>> | undefined;
    const secrets = new Map<string, { secret: string }>();
    const execution = new NativePackageExecution(async <T>(_command: string, args?: Record<string, unknown>) => {
      host ??= await startNativeExtensionHost(String(args?.sessionToken), 'http://tauri.localhost', {
        vault: {
          read: (key) => secrets.get(key),
          write: (key, value) => {
            if (value) secrets.set(key, value);
          },
        },
      });
      return { endpoint: host.endpoint } as T;
    });
    const store = new IndexedDbPackageInstallStore(`native-options-${crypto.randomUUID()}`);
    const manager = new LocalInstalledExtensions(execution, store);
    const id = 'org.example.catalog.source';
    try {
      const manifest = {
        ...examplePackageManifest(),
        preferences: [
          {
            sourceId: id,
            fields: [
              { key: 'token', title: 'Optional service token', kind: 'text', secret: true },
              { key: 'enabled', title: 'Use service', kind: 'boolean', secret: false, defaultValue: false },
            ],
          },
        ],
      };
      const source = `globalThis.moyaExtension=async(method,input,host)=>{
        if(method==='describe')return{apiVersion:1,sources:[{id:'${id}',cover:false}]};
        if(method==='source.listWorks')return{items:[{id:'work',title:(await host.request('preferences.get',{key:'enabled'}))?'Enabled':'Direct'}]};
      };`;
      const file = new File([await buildMoyaExtension({ manifest, source, license: 'fixture' })], 'options.moyaext');
      await manager.install(file, await manager.inspect(file));
      const first = await manager.preferences(id, { action: 'read' });
      expect(first.fields.find((field) => field.key === 'enabled')?.value).toBe(false);
      const saved = await manager.preferences(id, {
        action: 'save',
        revision: first.revision,
        changes: { token: 'do-not-return', enabled: true },
        privateOrigins: [],
      });
      expect(JSON.stringify(saved)).not.toContain('do-not-return');
      const works = await manager.listExternalSource(
        id,
        { brokers: { get: () => undefined } },
        {},
        AbortSignal.timeout(5000),
      );
      expect(works.items[0].title).toBe('Enabled');
    } finally {
      manager.dispose();
      await host?.close();
      await store.close();
    }
  });
  it('requires authentication/origin checks and runs installed TXT through binary transport, survives refresh and removal', async () => {
    let host: Awaited<ReturnType<typeof startNativeExtensionHost>> | undefined;
    const execution = new NativePackageExecution(async <T>(_command: string, args?: Record<string, unknown>) => {
      host ??= await startNativeExtensionHost(String(args?.sessionToken), 'http://tauri.localhost');
      return { endpoint: host.endpoint } as T;
    });
    const store = new IndexedDbPackageInstallStore(`native-fixture-${crypto.randomUUID()}`);
    const manager = new LocalInstalledExtensions(execution, store);
    const original = 'Original\r\n\r\n  Indented.\n';
    const source = `globalThis.moyaExtension=async(method,input,host)=>{
      if(method==='describe')return{apiVersion:1,sources:[{id:'org.example.catalog.source',cover:false}]};
      if(method==='source.listWorks')return{items:[{id:'work',title:'Work'}]};
      if(method==='source.getContent'){
        await host.request('storage.set',{key:'last-release',value:input.releaseId});
        return{kind:'text',asset:await host.request('asset.fromText',{text:${JSON.stringify(original)}})};
      }
    };`;
    try {
      await manager.refresh();
      expect(manager.getSnapshot().available).toBe(true);
      const denied = await fetch(host!.endpoint + '/prepare', { method: 'POST' });
      expect(denied.status).toBe(401);
      const cors = await fetch(host!.endpoint + '/prepare', {
        method: 'OPTIONS',
        headers: { Origin: 'https://untrusted.example' },
      });
      expect(cors.status).toBe(403);
      expect(cors.headers.has('Access-Control-Allow-Origin')).toBe(false);
      const manifest = examplePackageManifest();
      manifest.requestedAccess.storageKiB = 4;
      const file = new File([await buildMoyaExtension({ manifest, source, license: 'fixture' })], 'source.moyaext');
      const review = await manager.inspect(file);
      await manager.install(file, review);
      const snapshot = manager.getSnapshot();
      await manager.refresh();
      expect(manager.getSnapshot()).toBe(snapshot);
      const context = { brokers: { get: () => undefined } };
      const signal = new AbortController().signal;
      const page = await manager.listExternalSource('org.example.catalog.source', context, {}, signal);
      expect(page.items[0].title).toBe('Work');
      const downloaded = await manager.downloadExternalSource(
        'org.example.catalog.source',
        context,
        {
          key: { connectorId: 'org.example.catalog.source', remoteId: JSON.stringify(['work', 'one']) },
          fileName: 'one.txt',
        },
        signal,
      );
      expect(await downloaded.content.file.text()).toBe(original);
      expect(await store.readSourceState('org.example.catalog', 'org.example.catalog.source', 1)).toEqual({
        'last-release': 'one',
      });
      await manager.refresh();
      expect(manager.getSnapshot()).toBe(snapshot);
      await manager.change('org.example.catalog', 1, 'remove');
      expect(manager.getExternalSources()).toHaveLength(0);
      expect(await downloaded.content.file.text()).toBe(original);
    } finally {
      manager.dispose();
      await host?.close();
      await store.close();
    }
  });
  it('rejects truncated/trailing/duplicate native assets', async () => {
    const packet = (metadata: unknown, bytes: number[]) => {
      const json = new TextEncoder().encode(JSON.stringify(metadata));
      const all = new Uint8Array(4 + json.length + bytes.length);
      new DataView(all.buffer).setUint32(0, json.length);
      all.set(json, 4);
      all.set(bytes, 4 + json.length);
      return new Response(all);
    };
    await expect(
      decodeNativeAssets(packet({ result: null, assets: [{ handle: 'a', size: 3, type: 'text/plain' }] }, [1])),
    ).rejects.toThrow();
    await expect(decodeNativeAssets(packet({ result: null, assets: [] }, [1]))).rejects.toThrow();
    await expect(
      decodeNativeAssets(
        packet(
          {
            result: null,
            assets: [
              { handle: 'a', size: 1, type: 'text/plain' },
              { handle: 'a', size: 1, type: 'text/plain' },
            ],
          },
          [1, 2],
        ),
      ),
    ).rejects.toThrow();
  });
});
