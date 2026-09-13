import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../services/id-v2-migration/postgres-integration-harness.js';
import { PostgresPackageInstallStore } from './postgres-package-store.js';
import { PackageInstaller } from '../../../../src/extensions/packages/package-installer.js';
import { buildMoyaExtension } from '../../../../src/extensions/packages/package-builder.js';
import { examplePackageManifest } from '../../../../src/test/extension-package-fixture.js';

const harness = await startPostgresIntegrationHarness();
afterAll(async () => harness?.stop());
const suite = harness ? describe : describe.skip;

suite('installed package PostgreSQL ownership and activation CAS', () => {
  it('persists owner repository caches with atomic limits and removal fencing', async () => {
    await withPostgresSchema(harness!, 'extension_repositories', async (pool) => {
      await pool.query('create table users(id text primary key)');
      await pool.query("insert into users(id) values ('owner_a'), ('owner_b')");
      await pool.query(
        await readFile(new URL('../db/migrations/0048_extension_repositories.sql', import.meta.url), 'utf8'),
      );
      const a = new PostgresPackageInstallStore(pool, 'owner_a');
      const b = new PostgresPackageInstallStore(pool, 'owner_b');
      const index = { format: 'moya.extension.repository' as const, version: 1 as const, packages: [] };
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, n) =>
          a.saveRepository({ url: `https://catalog.example/${n}.json`, revision: 1, index }, 0),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(16);
      expect(await b.listRepositories()).toEqual([]);
      const restored = new PostgresPackageInstallStore(pool, 'owner_a');
      const [first] = await restored.listRepositories();
      expect(await restored.saveRepository({ url: first.url, revision: 2 }, 1)).toBe(true);
      expect(await a.saveRepository({ ...first, revision: 2 }, 1)).toBe(false);
      expect((await a.listRepositories()).find((item) => item.url === first.url)?.index).toBeUndefined();
    });
  });
  it('atomically preserves archives, rejects stale writes and isolates owner inventory', async () => {
    await withPostgresSchema(harness!, 'extension_install', async (pool) => {
      await pool.query('create table users(id text primary key)');
      await pool.query("insert into users(id) values ('owner_a'), ('owner_b')");
      await pool.query(
        await readFile(new URL('../db/migrations/0046_extension_packages.sql', import.meta.url), 'utf8'),
      );
      await pool.query(
        await readFile(new URL('../db/migrations/0047_extension_source_state.sql', import.meta.url), 'utf8'),
      );
      const a = new PostgresPackageInstallStore(pool, 'owner_a');
      const b = new PostgresPackageInstallStore(pool, 'owner_b');
      const installer = new PackageInstaller(a, async () => {});
      const initialManifest = examplePackageManifest();
      initialManifest.requestedAccess.storageKiB = 4;
      const archive = await buildMoyaExtension({
        manifest: initialManifest,
        source: 'globalThis.moyaExtension=()=>null',
        license: 'test',
      });
      const first = await installer.inspect(archive);
      const created = await installer.install(first, { digest: first.package.digest });
      const sourceId = 'org.example.catalog.source';
      const patch = (key: string, value: string) => ({ readKeys: [key], writes: [{ key, value }] });
      await Promise.all([
        a.commitSourceState(created.id, sourceId, 1, {}, patch('one', '1')),
        a.commitSourceState(created.id, sourceId, 1, {}, patch('two', '2')),
      ]);
      expect(await a.readSourceState(created.id, sourceId, 1)).toEqual({ one: '1', two: '2' });
      expect((await a.list())[0].revision).toBe(1);
      const lock = await pool.connect();
      await lock.query('begin');
      await lock.query('select 1 from extension_packages where user_id = $1 and package_id = $2 for update', [
        'owner_a',
        created.id,
      ]);
      const abort = new AbortController();
      const waiting = a.commitSourceState(created.id, sourceId, 1, {}, patch('cancelled', 'bad'), abort.signal);
      const cancelled = expect(waiting).rejects.toThrow();
      try {
        abort.abort();
        await lock.query('rollback');
        await cancelled;
      } finally {
        lock.release();
      }
      expect(await a.readSourceState(created.id, sourceId, 1)).toEqual({ one: '1', two: '2' });
      await expect(a.commitSourceState(created.id, sourceId, 1, {}, patch('one', 'lost'))).rejects.toThrow(
        'source_storage_conflict',
      );
      await expect(a.commitSourceState(created.id, sourceId, 1, {}, patch('large', 'x'.repeat(5000)))).rejects.toThrow(
        'source_storage_limit',
      );
      await expect(b.readSourceState(created.id, sourceId, 1)).rejects.toThrow('package_generation_changed');
      expect((await a.list())[0]).not.toHaveProperty('active.archive');
      expect((await a.list())[0]).not.toHaveProperty('active.settings');
      expect(await b.read(created.id)).toBeUndefined();
      expect(await b.list()).toEqual([]);
      expect(new Uint8Array(await (await a.read(created.id))!.active!.archive.arrayBuffer())).toEqual(
        new Uint8Array(await archive.arrayBuffer()),
      );
      const race = await Promise.all([
        a.compareAndSwap(created.id, 1, { ...created, revision: 2, enabled: false }),
        a.compareAndSwap(created.id, 1, { ...created, revision: 2, enabled: true }),
      ]);
      expect(race.filter(Boolean)).toHaveLength(1);
      await expect(a.commitSourceState(created.id, sourceId, 1, {}, patch('late', 'bad'))).rejects.toThrow(
        'package_generation_changed',
      );
      await installer.remove(created.id, 2);
      expect(await a.compareAndSwap(created.id, 0, created)).toBe(false);
      const tombstone = (await a.read(created.id))!;
      expect(tombstone.active).toBeUndefined();
      expect(tombstone.publisherPin).toBe('unsigned');
      expect(tombstone.revision).toBe(3);
      const fresh = await installer.inspect(archive);
      await installer.install(fresh, { digest: fresh.package.digest });
      expect(await a.readSourceState(created.id, sourceId, 4)).toEqual({});
      await a.commitSourceState(created.id, sourceId, 4, {}, patch('keep', 'state'));
      const manifest = examplePackageManifest();
      manifest.requestedAccess.storageKiB = 4;
      manifest.extension.version = '2.0.0';
      const next = await installer.inspect(
        await buildMoyaExtension({ manifest, source: 'globalThis.moyaExtension=()=>2', license: 'test' }),
      );
      const updated = await installer.install(next, { digest: next.package.digest });
      expect(await a.readSourceState(created.id, sourceId, updated.revision)).toEqual({ keep: 'state' });
      expect(updated.previous?.digest).toBe(first.package.digest);
      await installer.rollback(updated.id, updated.revision);
      expect(await a.readSourceState(created.id, sourceId, updated.revision + 1)).toEqual({ keep: 'state' });
      expect((await a.read(updated.id))?.active?.digest).toBe(first.package.digest);
      expect(await b.compareAndSwap(created.id, 0, created)).toBe(true);
      expect((await b.read(created.id))?.revision).toBe(1);
    });
  }, 30000);
});
