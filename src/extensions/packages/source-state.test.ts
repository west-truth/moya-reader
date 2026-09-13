import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { examplePackageManifest } from '../../test/extension-package-fixture';
import { buildMoyaExtension } from './package-builder';
import { IndexedDbPackageInstallStore } from './package-install-store';
import { PackageRuntimeCatalog } from './package-runtime-catalog';
import { checkProjectPackage, runProjectSource } from '../../../scripts/extensions/project';
import { createSourceStateSession, mergeSourceState } from './source-state';

const id = 'org.example.catalog';
const sourceId = `${id}.source`;
const signal = () => new AbortController().signal;
const set = (key: string, value: string) => ({ readKeys: [key], writes: [{ key, value }] });
const code = `globalThis.moyaExtension=async(method,input,host)=>{
  if(method==='describe')return{apiVersion:1,sources:[{id:'${sourceId}',cover:false}]};
  await host.request('storage.set',{key:input.query||'address',value:'catalog.example'});
  if(input.query==='loop'){while(true){}}
  return input.query==='invalid'?{wrong:true}:{items:[{id:'work',title:await host.request('storage.get',{key:input.query||'address'})}]};
};`;
async function setup() {
  const store = new IndexedDbPackageInstallStore('state-test', new IDBFactory());
  const catalog = new PackageRuntimeCatalog(store, {
    runtime: 'self-host-gateway',
    prepare: checkProjectPackage,
    async invoke(pkg, method, input, signal, state) {
      const response = await runProjectSource(pkg, method, input, { signal, state });
      return { result: response.result, assets: new Map(), stateChanges: response.stateChanges };
    },
  });
  const manifest = examplePackageManifest();
  manifest.requestedAccess.storageKiB = 4;
  const archive = await buildMoyaExtension({ manifest, source: code, license: 'fixture' });
  const plan = await catalog.installer.inspect(archive);
  await catalog.installer.install(plan, { digest: plan.package.digest });
  await catalog.refresh();
  return {
    store,
    catalog,
    manifest,
    archive,
    close: async () => {
      catalog.dispose();
      await store.close();
    },
  };
}

describe('source state ownership, lifetime and concurrent writes', () => {
  it('commits real guest writes without changing activation and discards invalid or cancelled invocations', async () => {
    const { store, catalog, close } = await setup();
    try {
      const sources = catalog.getSources();
      await catalog.invoke(sourceId, 'source.listWorks', {}, signal());
      expect(await store.readSourceState(id, sourceId, 1)).toEqual({ address: 'catalog.example' });
      const commit = store.commitSourceState.bind(store);
      let entered!: () => void;
      let release!: () => void;
      const atCommit = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      store.commitSourceState = async (...args) => {
        entered();
        await gate;
        return commit(...args);
      };
      const cancelled = new AbortController();
      const waiting = catalog.invoke(sourceId, 'source.listWorks', { query: 'at-commit' }, cancelled.signal);
      const commitRejected = expect(waiting).rejects.toThrow();
      await atCommit;
      cancelled.abort();
      release();
      await commitRejected;
      expect(await store.readSourceState(id, sourceId, 1)).toEqual({ address: 'catalog.example' });
      await catalog.refresh();
      expect(catalog.getSources()).toBe(sources);
      expect((await store.list())[0].revision).toBe(1);
      expect(JSON.stringify(await store.list())).not.toContain('"address":');
      await expect(catalog.invoke(sourceId, 'source.listWorks', { query: 'invalid' }, signal())).rejects.toThrow();
      const abort = new AbortController();
      const running = catalog.invoke(sourceId, 'source.listWorks', { query: 'loop' }, abort.signal);
      const rejected = expect(running).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 200));
      abort.abort();
      await rejected;
      expect(await store.readSourceState(id, sourceId, 1)).toEqual({ address: 'catalog.example' });
    } finally {
      await close();
    }
  });

  it('merges concurrent independent keys, rejects conflicting writes and fences changed installations', async () => {
    const { store, catalog, close } = await setup();
    try {
      await Promise.all([
        store.commitSourceState(id, sourceId, 1, {}, set('one', '1')),
        store.commitSourceState(id, sourceId, 1, {}, set('two', '2')),
      ]);
      expect(await store.readSourceState(id, sourceId, 1)).toEqual({ one: '1', two: '2' });
      await expect(store.commitSourceState(id, sourceId, 1, {}, set('one', 'lost'))).rejects.toThrow(
        'source_storage_conflict',
      );
      await expect(store.readSourceState(id, `${id}.other`, 1)).rejects.toThrow('package_generation_changed');
      await catalog.installer.setEnabled(id, 1, false);
      await expect(store.commitSourceState(id, sourceId, 1, {}, set('late', 'bad'))).rejects.toThrow(
        'package_generation_changed',
      );
      await catalog.installer.setEnabled(id, 2, true);
      expect(await store.readSourceState(id, sourceId, 3)).toEqual({ one: '1', two: '2' });
    } finally {
      await close();
    }
  });

  it('keeps data across an update/rollback, clears it on publisher change/removal and preserves source namespaces', async () => {
    const { store, catalog, manifest, archive, close } = await setup();
    try {
      await store.commitSourceState(id, sourceId, 1, {}, set('origin', 'old'));
      manifest.extension.version = '2.0.0';
      const plan = await catalog.installer.inspect(
        await buildMoyaExtension({ manifest, source: code, license: 'fixture' }),
      );
      await catalog.installer.install(plan, { digest: plan.package.digest });
      expect(await store.readSourceState(id, sourceId, 2)).toEqual({ origin: 'old' });
      await catalog.installer.rollback(id, 2);
      expect(await store.readSourceState(id, sourceId, 3)).toEqual({ origin: 'old' });
      const current = (await store.read(id))!;
      await store.compareAndSwap(id, 3, { ...current, revision: 4, publisherPin: 'different-publisher' });
      expect(await store.readSourceState(id, sourceId, 4)).toEqual({});
      await store.commitSourceState(id, sourceId, 4, {}, set('origin', 'new'));
      await catalog.installer.remove(id, 4);
      const reinstall = await catalog.installer.inspect(archive);
      await catalog.installer.install(reinstall, { digest: reinstall.package.digest, publisherChange: true });
      expect(await store.readSourceState(id, sourceId, 6)).toEqual({});
      const one = mergeSourceState({}, 'one', {}, set('same', '1'), 4);
      const two = mergeSourceState(one, 'two', {}, set('same', '2'), 4);
      expect(two).toEqual({ 'one/same': '1', 'two/same': '2' });
    } finally {
      await close();
    }
  });

  it('enforces grants, bounded keys/JSON and package-wide quota; deletion is distinct from null', async () => {
    const denied = createSourceStateSession();
    await expect(denied.methods['storage.get']({ key: 'address' }, signal())).rejects.toThrow('permission_denied');
    const state = createSourceStateSession({}, 1);
    for (const value of [String.fromCharCode(0), String.fromCharCode(0xd800), { [String.fromCharCode(0)]: 'bad' }])
      await expect(state.methods['storage.set']({ key: 'portable', value }, signal())).rejects.toThrow();
    await state.methods['storage.set']({ key: 'portable', value: '한글 🌙' }, signal());
    await state.methods['storage.remove']({ key: 'portable' }, signal());
    await expect(state.methods['storage.set']({ key: '../other', value: 1 }, signal())).rejects.toThrow();
    await expect(state.methods['storage.set']({ key: 'large', value: 'x'.repeat(1024) }, signal())).rejects.toThrow(
      'source_storage_limit',
    );
    await state.methods['storage.set']({ key: 'nullable', value: null }, signal());
    await state.methods['storage.remove']({ key: 'nullable' }, signal());
    expect(mergeSourceState({}, 'one', {}, state.changes(), 1)).toEqual({});
    const full = mergeSourceState({}, 'one', {}, set('value', 'x'.repeat(750)), 1);
    expect(() => mergeSourceState(full, 'two', {}, set('value', 'y'.repeat(750)), 1)).toThrow('source_storage_limit');
    const previous = { 'one/a': 'x'.repeat(750), 'one/b': 'y'.repeat(750), 'one/c': 'z'.repeat(750) };
    const smaller = mergeSourceState(
      previous,
      'one',
      { a: previous['one/a'] },
      { readKeys: ['a'], writes: [{ key: 'a' }] },
      1,
    );
    expect(smaller).not.toHaveProperty('one/a');
  });

  it('upgrades the existing local package DB without losing installed records and persists state on reopen', async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const request = factory.open('legacy', 1);
      request.onupgradeneeded = () =>
        request.result
          .createObjectStore('packages', { keyPath: 'id' })
          .put({ id: 'legacy', revision: 1, enabled: false, publisherPin: 'unsigned' });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });
    const { store: sourceStore, close } = await setup();
    const store = new IndexedDbPackageInstallStore('legacy', factory);
    try {
      expect((await store.list())[0].id).toBe('legacy');
      const record = (await sourceStore.read(id))!;
      await store.compareAndSwap(id, 0, record);
      await store.commitSourceState(id, sourceId, 1, {}, set('address', 'saved'));
      await store.close();
      expect(await store.readSourceState(id, sourceId, 1)).toEqual({ address: 'saved' });
    } finally {
      await store.close();
      await close();
    }
  });
});
