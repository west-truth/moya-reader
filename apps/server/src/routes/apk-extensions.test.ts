import 'fake-indexeddb/auto';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { registerAuthHook } from '../auth.js';
import type { ServerConfig } from '../config.js';
import { registerExtensionPackageRoutes } from './extension-packages.js';
import { registerApkExtensionRoutes } from './apk-extensions.js';
import { ApkExtensionHost } from '../extensions/apk-extension-host.js';
import { dispatchApkCommand } from '../extensions/apk-command.js';
import { createNodePackageExecution } from '../extensions/node-package-execution.js';
import { IndexedDbPackageInstallStore } from '../../../../src/extensions/packages/package-install-store.js';
import { ApkInstallations } from '../../../../services/apk-worker/installations.mjs';
import { ApkSourceCatalog } from '../../../../services/apk-worker/catalog.mjs';
import type { JavaApkTools } from '../../../../services/apk-worker/java-tools.mjs';
import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';

describe('APK source integration', () => {
  it('keeps management authenticated and feeds the existing source/cover/CBZ routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moya-apk-http-'));
    const headers = { authorization: 'Bearer apk-fixture' };
    const image = Buffer.from([255, 216, 255, 217]);
    const source = { id: '123', name: 'Novel image source', lang: 'ko' };
    const metadata = {
      pkg: 'org.example.manga',
      entry: 'org.example.manga.Factory',
      code: 1,
      version: '1.4.1',
      signers: ['a'.repeat(64)],
    };
    const savedPreferences: Record<string, unknown> = {};
    const tools: JavaApkTools = {
      inspect: async () => metadata,
      convert: async () => {},
      describe: async () => [source],
      worker: () => ({
        busy: false,
        close() {},
        async request(method, params) {
          if (method === 'preferences')
            return {
              fields: [
                { key: '["123","enabled"]', kind: 'boolean', value: savedPreferences['["123","enabled"]'] ?? false },
              ],
              groups: [],
            };
          if (method === 'preferences-save') {
            Object.assign(savedPreferences, params?.values);
            return { saved: true };
          }
          if (method === 'list')
            return {
              items: [{ url: '/work/1', title: 'Work', cover: 'https://example.org/cover.jpg' }],
              hasNextPage: false,
            };
          if (method === 'detail') return { url: '/work/1', title: 'Work', cover: 'https://example.org/cover.jpg' };
          if (method === 'chapters') return [{ url: '/chapter/1', title: 'Chapter', number: 1 }];
          if (method === 'pages') return [{ index: 0, url: '', imageUrl: 'https://example.org/image.jpg' }];
          return { contentType: 'image/jpeg', base64: image.toString('base64') };
        },
      }),
    };
    const store = await new ApkInstallations(root, tools).open();
    const review = await store.inspect(Buffer.from('test archive'), metadata);
    await store.install(review.id, review.revision);
    const catalog = new ApkSourceCatalog(store, tools);
    await catalog.refresh();
    const install = vi.fn();
    const apk = {
      catalog,
      store,
      snapshot: () => ({ available: true, ...store.snapshot(), repositories: [] }),
      install,
      close: () => catalog.close(),
      preferences: ApkExtensionHost.prototype.preferences,
      savePreferences: ApkExtensionHost.prototype.savePreferences,
    } as unknown as ApkExtensionHost;
    const app = Fastify();
    await registerAuthHook(app, { host: '127.0.0.1', authToken: 'apk-fixture' } as ServerConfig);
    await registerApkExtensionRoutes(app, apk);
    await registerExtensionPackageRoutes(
      app,
      new IndexedDbPackageInstallStore(`apk-http-${crypto.randomUUID()}`),
      createNodePackageExecution(),
      apk,
    );
    try {
      expect((await app.inject({ method: 'GET', url: '/api/apk-extensions' })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/apk-extensions/install',
            headers,
            payload: { id: 'plan', revision: 0 },
          })
        ).statusCode,
      ).toBe(400);
      expect(install).not.toHaveBeenCalled();
      const preferences = await app.inject({
        method: 'POST',
        url: '/api/apk-extensions/preferences',
        headers,
        payload: { pkg: metadata.pkg },
      });
      expect(preferences.statusCode).toBe(200);
      expect(preferences.headers['cache-control']).toBe('no-store');
      expect(preferences.json().fields[0].value).toBe(false);
      expect(
        (await dispatchApkCommand(apk, { action: 'preferences', pkg: metadata.pkg }, new AbortController().signal))
          .value,
      ).toEqual(preferences.json());
      const settingsPayload = {
        pkg: metadata.pkg,
        revision: store.snapshot().revision,
        values: { '["123","enabled"]': true },
        privateOrigins: [],
      };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/apk-extensions/preferences-save',
            headers,
            payload: settingsPayload,
          })
        ).statusCode,
      ).toBe(200);
      expect(savedPreferences['["123","enabled"]']).toBe(true);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/apk-extensions/preferences-save',
            headers,
            payload: settingsPayload,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/apk-extensions/preferences-save',
            headers,
            payload: { ...settingsPayload, values: { unexpected: ['invalid'] } },
          })
        ).statusCode,
      ).toBe(422);
      const inventory = (await app.inject({ method: 'GET', url: '/api/extensions/packages', headers })).json();
      expect(inventory.sources[0].apkPackageId).toBe(metadata.pkg);
      expect(inventory.sources[0].descriptor.seriesProfile.kind).toBe('image_series');
      const prefix = `/api/extensions/sources/${inventory.sources[0].descriptor.id}`;
      const listing = (await app.inject({ method: 'POST', url: prefix + '/list', headers, payload: {} })).json();
      const workId = listing.items[0].key.remoteId;
      const cover = await app.inject({ method: 'POST', url: prefix + '/cover', headers, payload: { workId } });
      expect(cover.statusCode).toBe(200);
      expect(cover.rawPayload).toEqual(image);
      const chapters = (
        await app.inject({ method: 'POST', url: prefix + '/list', headers, payload: { parentRef: workId } })
      ).json();
      expect(chapters).toHaveProperty('items');
      const chapter = chapters.items[0];
      const downloaded = await app.inject({
        method: 'POST',
        url: prefix + '/download',
        headers,
        payload: { key: chapter.key, fileName: chapter.importFileName },
      });
      expect(downloaded.statusCode).toBe(200);
      const zip = new ZipReader(new BlobReader(new Blob([Uint8Array.from(downloaded.rawPayload)])), {
        useWebWorkers: false,
      });
      try {
        const entries = await zip.getEntries();
        expect(entries).toHaveLength(1);
        const entry = entries[0];
        if (entry.directory) throw new Error('Expected image');
        expect(await entry.getData(new Uint8ArrayWriter())).toEqual(Uint8Array.from(image));
      } finally {
        await zip.close();
      }
      await store.setEnabled(metadata.pkg, false, store.snapshot().revision);
      await catalog.refresh();
      expect((await app.inject({ method: 'POST', url: prefix + '/list', headers, payload: {} })).statusCode).not.toBe(
        200,
      );
    } finally {
      await app.close();
      catalog.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('reports an unavailable optional worker without blocking existing server features', async () => {
    const app = Fastify();
    await registerApkExtensionRoutes(app);
    try {
      expect((await app.inject('/api/apk-extensions')).json()).toEqual({
        available: false,
        revision: 0,
        packages: [],
        repositories: [],
      });
    } finally {
      await app.close();
    }
  });
  it('maps asynchronous preference failures without exposing original extension errors', async () => {
    const app = Fastify();
    await registerApkExtensionRoutes(app, {
      close() {},
      preferences: async () => {
        throw new Error('original error with fixture-secret');
      },
    } as unknown as ApkExtensionHost);
    try {
      const reply = await app.inject({
        method: 'POST',
        url: '/api/apk-extensions/preferences',
        payload: { pkg: 'org.example.source' },
      });
      expect(reply.statusCode).toBe(422);
      expect(reply.json()).toEqual({ error: 'apk_operation_failed' });
    } finally {
      await app.close();
    }
  });
});
