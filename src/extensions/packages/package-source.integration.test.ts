import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { readDocumentSeriesArchive } from '@noveldesk/document-series-core';
import {
  buildProject,
  checkProjectPackage,
  runProjectSource,
  type DevelopmentFixture,
} from '../../../scripts/extensions/project';
import { AppExternalSourceRegistry } from '../../external-sources/app-external-source-registry';
import { InstalledPackageSourceRegistry } from '../../external-sources/installed-package-source-registry';
import { assembleDocumentSeries } from '../../external-sources/series/document-series-assembler';
import type { ExternalSourceCollectionDescriptorV2 } from '../../external-sources/contracts';
import { PackageRuntimeCatalog, type PackageExecutionPort } from './package-runtime-catalog';
import { IndexedDbPackageInstallStore } from './package-install-store';
import { buildMoyaExtension } from './package-builder';
import { packageSha256 } from './package-archive';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const context = { brokers: { get: () => undefined } };
const signal = () => new AbortController().signal;

async function setup(example: 'text-catalog' | 'image-catalog', overrides: Partial<PackageExecutionPort> = {}) {
  const folder = `packages/extension-runtime/examples/${example}`;
  const pkg = await buildProject(folder);
  const fixtures: DevelopmentFixture[] = JSON.parse(await readFile(`${folder}/fixtures.json`, 'utf8'));
  const store = new IndexedDbPackageInstallStore(`moya-extension-test-${crypto.randomUUID()}`);
  cleanups.push(() => store.close());
  const port: PackageExecutionPort = {
    runtime: 'tauri-native',
    prepare: checkProjectPackage,
    async invoke(pkg, method, input, signal) {
      const value = await runProjectSource(pkg, method, input, { fixtures, signal });
      return {
        result: value.result,
        assets: new Map(
          value.assets.map((asset) => [
            asset.handle,
            new Blob([Uint8Array.from(asset.bytes)], { type: asset.contentType }),
          ]),
        ),
      };
    },
    ...overrides,
  };
  const catalog = new PackageRuntimeCatalog(store, port);
  const plan = await catalog.installer.inspect(pkg.archive);
  await catalog.installer.install(plan, { digest: pkg.digest });
  await catalog.refresh();
  const sources = new InstalledPackageSourceRegistry(catalog);
  cleanups.push(() => {
    sources.dispose();
    catalog.dispose();
  });
  return {
    pkg,
    catalog,
    store,
    sources,
    registry: new AppExternalSourceRegistry([], sources),
    id: pkg.manifest.extension.contributes!.externalSources![0].id,
  };
}

describe('installed package source adapter and lifecycle', () => {
  it('makes concurrent cold-start refresh callers wait for usable sources', async () => {
    const { store, id } = await setup('text-catalog');
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let preparations = 0;
    const catalog = new PackageRuntimeCatalog(store, {
      runtime: 'tauri-native',
      prepare: () => (++preparations === 1 ? firstGate : secondGate),
      invoke: async () => ({ result: { items: [] }, assets: new Map() }),
    });
    cleanups.push(() => catalog.dispose());
    const first = catalog.refresh().then(() => catalog.getSource(id));
    await vi.waitFor(() => expect(preparations).toBe(1));
    const second = catalog.refresh();
    releaseFirst();
    try {
      expect(await first).toBeDefined();
    } finally {
      releaseSecond();
      await second;
    }
  });

  it('includes a lifecycle change arriving during activation before refresh callers resume', async () => {
    const { store, id, pkg } = await setup('text-catalog');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let preparing = false;
    const catalog = new PackageRuntimeCatalog(store, {
      runtime: 'tauri-native',
      prepare: () => {
        preparing = true;
        return gate;
      },
      invoke: async () => ({ result: { items: [] }, assets: new Map() }),
    });
    cleanups.push(() => catalog.dispose());
    const first = catalog.refresh();
    await vi.waitFor(() => expect(preparing).toBe(true));
    await catalog.installer.setEnabled(pkg.manifest.extension.id, 1, false);
    const second = catalog.refresh();
    release();
    await Promise.all([first, second]);
    expect(catalog.getSource(id)).toBeUndefined();
  });

  it('feeds real guest TXT bytes through the existing registry and document-series assembler', async () => {
    const { catalog, registry, id } = await setup('text-catalog');
    const works = await registry.listExternalSource(id, context, {}, signal());
    const releases = await registry.listExternalSource(
      id,
      context,
      { parentRef: works.items[0].navigationRef },
      signal(),
    );
    const item = releases.items[0];
    const downloaded = await registry.downloadExternalSource(
      id,
      context,
      { key: item.key, fileName: item.importFileName! },
      signal(),
    );
    const original = new Uint8Array(await downloaded.file.arrayBuffer());
    const assembled = await assembleDocumentSeries({
      collection: item.collection as ExternalSourceCollectionDescriptorV2,
      targetBookId: 'test-library-work',
      releases: [{ item, content: downloaded.content!, sourceContentHash: await packageSha256(original) }],
      expectedBase: { kind: 'absent' },
      signal: signal(),
    });
    const reopened = await readDocumentSeriesArchive(assembled.file!);
    if (!reopened) throw new Error('missing assembled document');
    expect(new Uint8Array(await [...reopened.sources.values()][0].arrayBuffer())).toEqual(original);
    expect(new TextDecoder().decode(original)).toContain('\r\n\r\n  Leading spaces');
    await catalog.disable(id);
    expect(registry.getExternalSources()).toHaveLength(0);
    // Disabling the extension does not own/delete previously downloaded or assembled library content.
    expect((await readDocumentSeriesArchive(assembled.file!))?.sources.size).toBe(1);
  });

  it('builds an ordered CBZ from host assets through the same normalized download port', async () => {
    const { registry, id } = await setup('image-catalog');
    const works = await registry.listExternalSource(id, context, {}, signal());
    const releases = await registry.listExternalSource(
      id,
      context,
      { parentRef: works.items[0].navigationRef },
      signal(),
    );
    const item = releases.items[0];
    const downloaded = await registry.downloadExternalSource(
      id,
      context,
      { key: item.key, fileName: item.importFileName! },
      signal(),
    );
    expect(downloaded.content?.kind).toBe('image_archive');
    const zip = new ZipReader(new BlobReader(downloaded.file), { useWebWorkers: false });
    try {
      const entries = await zip.getEntries();
      expect(entries.map((entry) => entry.filename)).toEqual(['00001.png']);
      const entry = entries[0];
      if (entry.directory) throw new Error('unexpected directory');
      expect((await entry.getData(new Uint8ArrayWriter()))!.slice(0, 8)).toEqual(
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      );
    } finally {
      await zip.close();
    }
  });

  it('rejects late work after disable and keeps unchanged refreshes quiet', async () => {
    let finish!: (value: { result: unknown; assets: Map<string, Blob> }) => void;
    let started!: () => void;
    let requestSignal: AbortSignal | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { catalog, id } = await setup('text-catalog', {
      invoke: async (_pkg, _method, _input, signal) => {
        requestSignal = signal;
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const changed = vi.fn();
    catalog.subscribe(changed);
    const original = catalog.getSources();
    await catalog.refresh();
    expect(catalog.getSources()).toBe(original);
    expect(changed).not.toHaveBeenCalled();
    const pending = catalog.invoke(id, 'source.listWorks', {}, signal());
    await ready;
    await catalog.disable(id);
    expect(requestSignal?.aborted).toBe(true);
    finish({ result: { items: [] }, assets: new Map() });
    await expect(pending).rejects.toThrow();
  });

  it('updates and rolls back with stable source identity; corrupt installed packages do not activate', async () => {
    const { pkg, catalog, store, id } = await setup('text-catalog');
    const manifest = structuredClone(pkg.manifest);
    const nextManifest = { ...manifest, extension: { ...manifest.extension, version: '1.0.1' } };
    const archive = await buildMoyaExtension({ manifest: nextManifest, source: pkg.source, license: 'test license' });
    const plan = await catalog.installer.inspect(archive);
    await catalog.installer.install(plan, { digest: plan.package.digest });
    await catalog.refresh();
    expect(catalog.getSource(id)?.generation).toContain(plan.package.digest);
    const updated = (await store.read(pkg.manifest.extension.id))!;
    await catalog.installer.rollback(updated.id, updated.revision);
    await catalog.refresh();
    expect(catalog.getSource(id)?.generation).toContain(pkg.digest);
    const restored = (await store.read(updated.id))!;
    await store.compareAndSwap(restored.id, restored.revision, {
      ...restored,
      revision: restored.revision + 1,
      active: { ...restored.active!, archive: new Blob(['corrupt']) },
    });
    await catalog.refresh();
    expect(catalog.getSource(id)).toBeUndefined();
    expect(catalog.getErrors()).toEqual([{ packageId: restored.id, code: 'package_activation_failed' }]);
  });
});
