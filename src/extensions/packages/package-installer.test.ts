import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { examplePackageManifest } from '../../test/extension-package-fixture';
import { buildMoyaExtension } from './package-builder';
import { IndexedDbPackageInstallStore } from './package-install-store';
import { PackageInstaller } from './package-installer';

async function archive(
  version = '1.0.0',
  options: { source?: string; origin?: string; signingKey?: CryptoKeyPair } = {},
) {
  const manifest = examplePackageManifest();
  manifest.extension.version = version;
  if (options.origin) manifest.requestedAccess.networkOrigins.push(options.origin);
  return buildMoyaExtension({
    manifest,
    source: options.source ?? 'globalThis.moyaExtension=()=>true;',
    license: 'MIT',
    signingKey: options.signingKey,
  });
}

function setup() {
  const factory = new IDBFactory();
  const store = new IndexedDbPackageInstallStore('test', factory);
  const prepare = vi.fn(async () => {});
  const installer = new PackageInstaller(store, prepare);
  return { store, factory, installer, prepare };
}

async function install(installer: PackageInstaller, file: Blob) {
  const plan = await installer.inspect(file);
  return installer.install(plan, { digest: plan.package.digest });
}

describe('durable package install and update', () => {
  it('persists installs across reopening without changing Library databases', async () => {
    const { installer, store, factory } = setup();
    const first = await install(installer, await archive());
    expect(first.revision).toBe(1);
    await store.close();
    const reopened = new IndexedDbPackageInstallStore('test', factory);
    const found = await reopened.read(first.id);
    expect(found?.active?.digest).toBe(first.active?.digest);
    expect((await factory.databases()).map(({ name }) => name)).toEqual(['test']);
    await reopened.close();
  });
  it('deduplicates identical archives and refuses different bytes for the same version', async () => {
    const { installer, prepare } = setup();
    const file = await archive();
    const first = await install(installer, file);
    expect((await install(installer, file)).revision).toBe(first.revision);
    expect(prepare).toHaveBeenCalledTimes(1);
    await expect(installer.inspect(await archive('1.0.0', { source: 'changed' }))).rejects.toMatchObject({
      code: 'package_version_conflict',
    });
  });
  it('keeps the old active version when preparation fails and supports rollback after a good update', async () => {
    const { installer, prepare, store } = setup();
    const first = await install(installer, await archive());
    prepare.mockRejectedValueOnce(new Error('unsupported runtime'));
    await expect(install(installer, await archive('2.0.0'))).rejects.toThrow('unsupported runtime');
    expect((await store.read(first.id))?.active?.digest).toBe(first.active?.digest);
    const second = await install(installer, await archive('2.0.0'));
    await installer.rollback(second.id, second.revision);
    const restored = await store.read(first.id);
    expect(restored?.active?.digest).toBe(first.active?.digest);
    expect(restored?.previous?.digest).toBe(second.active?.digest);
  });
  it('fences simultaneous reviewed installs and stale work after removal', async () => {
    const { installer, store } = setup();
    const file = await archive();
    const a = await installer.inspect(file);
    const b = await installer.inspect(file);
    const results = await Promise.allSettled([
      installer.install(a, { digest: a.package.digest }),
      installer.install(b, { digest: b.package.digest }),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const current = (await store.list())[0];
    const update = await installer.inspect(await archive('2.0.0'));
    await installer.remove(current.id, current.revision);
    await expect(installer.install(update, { digest: update.package.digest })).rejects.toMatchObject({
      code: 'package_install_conflict',
    });
    expect((await store.read(current.id))?.active).toBeUndefined();
    const reinstalled = await install(installer, file);
    expect(reinstalled.revision).toBe(3);
  });
  it('requires explicit review for downgrade, publisher changes and shows access growth', async () => {
    const { installer, store } = setup();
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const first = await install(installer, await archive('2.0.0', { signingKey: key }));
    const plan = await installer.inspect(await archive('1.0.0', { origin: 'https://images.example' }));
    expect(plan).toMatchObject({ downgrade: true, publisherChanged: true, expandedAccess: true });
    await expect(installer.install(plan, { digest: plan.package.digest })).rejects.toMatchObject({
      code: 'publisher_change_requires_review',
    });
    await installer.remove(first.id, first.revision);
    const afterRemoval = await installer.inspect(await archive('3.0.0'));
    expect(afterRemoval.publisherChanged).toBe(true);
    expect((await store.read(first.id))?.publisherPin).toBe(first.publisherPin);
  });
  it('does not activate cancelled preparation or a package other than the approved digest', async () => {
    const { installer, prepare, store } = setup();
    const controller = new AbortController();
    const plan = await installer.inspect(await archive());
    await expect(installer.install(plan, { digest: 'wrong' })).rejects.toMatchObject({
      code: 'package_approval_mismatch',
    });
    prepare.mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(installer.install(plan, { digest: plan.package.digest }, controller.signal)).rejects.toBeDefined();
    expect(await store.list()).toHaveLength(0);
  });
});
