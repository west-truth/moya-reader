import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IndexedDbPackageInstallStore } from './package-install-store';
import { PackageRepositories } from './package-repositories';
import type { RepositoryIndex } from './repository-contract';
const url = 'https://catalog.example/index.json';
const index: RepositoryIndex = {
  format: 'moya.extension.repository',
  version: 1,
  name: 'Catalog',
  packages: [
    { id: 'org.example.catalog', version: '1.0.0', archive: './one.moyaext', sha256: 'a'.repeat(64), name: 'Example' },
  ],
};
const execution = {
  runtime: 'tauri-native' as const,
  prepare: async () => {},
  invoke: async () => ({ result: null, assets: new Map() }),
  listRepository: async () => index,
  downloadRepository: async () => new Blob(['fixture']),
};

describe('saved repositories and cached catalogs', () => {
  it('restores cached lists without network, preserves cache after errors and isolates downloaded selection', async () => {
    const store = new IndexedDbPackageInstallStore('repositories', new IDBFactory());
    const service = new PackageRepositories(store, execution);
    try {
      await service.refresh(url);
      await store.close();
      const offline = new PackageRepositories(store, {
        ...execution,
        listRepository: async () => {
          throw new Error('offline');
        },
      });
      expect((await offline.list())[0].index).toEqual(index);
      await expect(offline.refresh(url)).rejects.toThrow('offline');
      expect((await offline.list())[0].revision).toBe(1);
      await expect(service.download(url, 'org.example.other', 'a'.repeat(64))).rejects.toThrow(
        'package_repository_conflict',
      );
      expect(await (await service.download(url, index.packages[0].id, index.packages[0].sha256)).text()).toBe(
        'fixture',
      );
      expect(await store.list()).toEqual([]);
    } finally {
      await store.close();
    }
  });
  it('does not resurrect a deleted repository when its refresh finishes late', async () => {
    const store = new IndexedDbPackageInstallStore('repo-race', new IDBFactory());
    const service = new PackageRepositories(store, execution);
    try {
      await service.refresh(url);
      let release!: (value: RepositoryIndex) => void;
      let reached!: () => void;
      const entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const slow = new PackageRepositories(store, {
        ...execution,
        listRepository: async () => {
          reached();
          return new Promise<RepositoryIndex>((resolve) => {
            release = resolve;
          });
        },
      });
      const refreshing = slow.refresh(url);
      const rejected = expect(refreshing).rejects.toThrow('package_repository_conflict');
      await entered;
      await service.remove(url, 1);
      release(index);
      await rejected;
      expect(await service.list()).toEqual([]);
      expect((await service.refresh(url)).revision).toBe(3);
    } finally {
      await store.close();
    }
  });
  it('enforces the repository limit even for parallel adds', async () => {
    const store = new IndexedDbPackageInstallStore('repo-limit', new IDBFactory());
    const service = new PackageRepositories(store, execution);
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, n) => service.refresh(`https://catalog.example/${n}.json`)),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(16);
      expect(await service.list()).toHaveLength(16);
    } finally {
      await store.close();
    }
  });
  it('migrates a version-two install database without dropping packages or state', async () => {
    const factory = new IDBFactory();
    const database = await new Promise<IDBDatabase>((resolve) => {
      const request = factory.open('repo-migration', 2);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('packages', { keyPath: 'id' });
        request.result.createObjectStore('source-state');
      };
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = database.transaction('source-state', 'readwrite');
      tx.objectStore('source-state').put({ one: 'kept' }, 'fixture');
      tx.oncomplete = () => resolve();
    });
    database.close();
    const store = new IndexedDbPackageInstallStore('repo-migration', factory);
    await new PackageRepositories(store, execution).refresh(url);
    await store.close();
    const migrated = await new Promise<IDBDatabase>((resolve) => {
      const request = factory.open('repo-migration');
      request.onsuccess = () => resolve(request.result);
    });
    const state = await new Promise((resolve) => {
      const request = migrated.transaction('source-state').objectStore('source-state').get('fixture');
      request.onsuccess = () => resolve(request.result);
    });
    expect(state).toEqual({ one: 'kept' });
    expect(migrated.version).toBe(3);
    migrated.close();
  });
});
