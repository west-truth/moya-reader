import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { PackageInstaller } from '../../src/extensions/packages/package-installer';
import { IndexedDbPackageInstallStore } from '../../src/extensions/packages/package-install-store';
import { checkProjectPackage } from './project';
import { generatePublisherKey, loadPublisherKey } from './signing';
import { scaffoldProject } from './scaffold';
import { buildProject } from './project';
import { verifyMoyaExtension } from '../../src/extensions/packages/package-archive';
const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'moya-sign-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('signs successive versions with a stable host-verifiable publisher and never replaces the key', async () => {
  const root = await temporary();
  const keys = join(root, 'keys');
  const project = join(root, 'source');
  const publisher = await generatePublisherKey(keys);
  const keyPath = join(keys, 'publisher.pem');
  const before = await readFile(keyPath);
  await expect(generatePublisherKey(keys)).rejects.toThrow('EEXIST');
  expect(await readFile(keyPath)).toEqual(before);
  if (process.platform !== 'win32') expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
  await scaffoldProject(project, { id: 'org.example.signed', kind: 'text' });
  for (const version of ['1.0.0', '1.1.0']) {
    const path = join(project, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.extension.version = version;
    await writeFile(path, JSON.stringify(manifest));
    const pkg = await buildProject(project, await loadPublisherKey(keyPath));
    const reopened = await verifyMoyaExtension(pkg.archive);
    expect(reopened.publisherFingerprint).toBe(publisher.publicKeyFingerprint);
    expect(reopened.manifest.extension.version).toBe(version);
    expect(new TextDecoder().decode(await pkg.archive.arrayBuffer())).not.toContain('PRIVATE KEY');
  }
});
it('rejects unsupported key algorithms instead of creating an incompatible package', async () => {
  const root = await temporary();
  const path = join(root, 'key.pem');
  const { privateKey } = generateKeyPairSync('ed25519');
  await writeFile(path, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await expect(loadPublisherKey(path)).rejects.toThrow('publisher_key_requires_p256');
});

it('installs CLI-signed versions, keeps disabled state after update/reopen, and rejects an unapproved publisher change', async () => {
  const root = await temporary();
  const keys = join(root, 'keys');
  const publisher = await generatePublisherKey(keys);
  const project = join(root, 'source');
  await scaffoldProject(project, { id: 'org.example.release', kind: 'text' });
  const factory = new IDBFactory();
  const store = new IndexedDbPackageInstallStore('signed-cli-audit', factory);
  const installer = new PackageInstaller(store, (pkg) => checkProjectPackage(pkg));
  try {
    for (const version of ['1.0.0', '1.1.0']) {
      const path = join(project, 'manifest.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.extension.version = version;
      await writeFile(path, JSON.stringify(manifest));
      const pkg = await buildProject(project, await loadPublisherKey(join(keys, 'publisher.pem')));
      const plan = await installer.inspect(pkg.archive);
      const installed = await installer.install(plan, { digest: pkg.digest });
      expect(installed.publisherPin).toBe(publisher.publicKeyFingerprint);
      if (version === '1.0.0') await installer.setEnabled(installed.id, installed.revision, false);
      else {
        expect(installed.enabled).toBe(false);
        expect(installed.previous?.manifest.extension.version).toBe('1.0.0');
      }
    }
    const replacement = join(root, 'replacement');
    await generatePublisherKey(replacement);
    const path = join(project, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.extension.version = '1.2.0';
    await writeFile(path, JSON.stringify(manifest));
    const wrongPublisher = await buildProject(project, await loadPublisherKey(join(replacement, 'publisher.pem')));
    const review = await installer.inspect(wrongPublisher.archive);
    await expect(installer.install(review, { digest: wrongPublisher.digest })).rejects.toMatchObject({
      code: 'publisher_change_requires_review',
    });
  } finally {
    await store.close();
  }
  const reopened = new IndexedDbPackageInstallStore('signed-cli-audit', factory);
  try {
    const record = await reopened.read('org.example.release');
    expect(record?.publisherPin).toBe(publisher.publicKeyFingerprint);
    expect(record?.enabled).toBe(false);
    expect(record?.active?.manifest.extension.version).toBe('1.1.0');
  } finally {
    await reopened.close();
  }
});
