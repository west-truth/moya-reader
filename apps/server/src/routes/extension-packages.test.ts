import 'fake-indexeddb/auto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerAuthHook } from '../auth.js';
import type { ServerConfig } from '../config.js';
import { registerExtensionPackageRoutes } from './extension-packages.js';
import { createNodePackageExecution } from '../extensions/node-package-execution.js';
import { IndexedDbPackageInstallStore } from '../../../../src/extensions/packages/package-install-store.js';
import { buildMoyaExtension } from '../../../../src/extensions/packages/package-builder.js';
import { examplePackageManifest } from '../../../../src/test/extension-package-fixture.js';

const headers = { authorization: 'Bearer fixture-token' };
const binaryHeaders = { ...headers, 'content-type': 'application/octet-stream' };
const id = 'org.example.catalog.source';
const body = 'Original text\r\n\r\n  Indented line.\n';
const source = `globalThis.moyaExtension=async (method,input,host)=>{
 if(method==='describe') return {apiVersion:1,sources:[{id:'${id}',cover:false}]};
 if(method==='source.listWorks') return {items:[{id:'work',title:'Work'}]};
 if(method==='source.getWork') return {id:'work',title:'Work'};
 if(method==='source.listReleases') return {items:[{id:'one',title:'Chapter one',order:1}]};
 if(method==='source.getContent') return {kind:'text',asset:await host.request('asset.fromText',{text:${JSON.stringify(body)}})};
};`;

describe('authenticated installed source HTTP flow', () => {
  it('inspects without execution, installs after review, downloads raw text, then fences stale/removal requests', async () => {
    const app = Fastify();
    const store = new IndexedDbPackageInstallStore(`moya-route-test-${crypto.randomUUID()}`);
    const execution = createNodePackageExecution();
    execution.prepare = vi.fn(execution.prepare);
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, bytes, done) =>
      done(null, bytes),
    );
    await registerAuthHook(app, { host: '127.0.0.1', authToken: 'fixture-token' } as ServerConfig);
    await registerExtensionPackageRoutes(app, store, execution);
    try {
      const archive = await buildMoyaExtension({ manifest: examplePackageManifest(), source, license: 'test' });
      const payload = Buffer.from(await archive.arrayBuffer());
      expect((await app.inject({ method: 'GET', url: '/api/extensions/packages' })).statusCode).toBe(401);
      const inspected = await app.inject({
        method: 'POST',
        url: '/api/extensions/packages/inspect',
        headers: binaryHeaders,
        payload,
      });
      expect(inspected.statusCode).toBe(200);
      expect(execution.prepare).not.toHaveBeenCalled();
      expect(inspected.json().package).not.toHaveProperty('source');
      const review = inspected.json();
      const url = `/api/extensions/packages/install?revision=${review.expectedRevision}&digest=${review.package.digest}`;
      expect((await app.inject({ method: 'POST', url, headers: binaryHeaders, payload })).statusCode).toBe(200);
      expect(execution.prepare).toHaveBeenCalled();
      expect((await app.inject({ method: 'POST', url, headers: binaryHeaders, payload })).statusCode).toBe(409);
      const inventory = await app.inject({ method: 'GET', url: '/api/extensions/packages', headers });
      expect(inventory.json().packages[0].active).not.toHaveProperty('archive');
      expect(inventory.json().sources).toHaveLength(1);
      const listing = await app.inject({
        method: 'POST',
        url: `/api/extensions/sources/${id}/list`,
        headers,
        payload: { parentRef: 'work' },
      });
      expect(listing.statusCode).toBe(200);
      const item = listing.json().items[0];
      const downloaded = await app.inject({
        method: 'POST',
        url: `/api/extensions/sources/${id}/download`,
        headers,
        payload: { key: item.key, fileName: item.importFileName },
      });
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.rawPayload).toEqual(Buffer.from(body));
      const removed = await app.inject({
        method: 'POST',
        url: '/api/extensions/packages/org.example.catalog/change',
        headers,
        payload: { action: 'remove', revision: 1 },
      });
      expect(removed.statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url, headers: binaryHeaders, payload })).statusCode).toBe(409);
      expect(
        (await app.inject({ method: 'GET', url: '/api/extensions/packages', headers })).json().sources,
      ).toHaveLength(0);
    } finally {
      await app.close();
      await store.close();
    }
  });

  it('rejects mismatched approval and suppresses raw preparation errors', async () => {
    const app = Fastify();
    const store = new IndexedDbPackageInstallStore(`moya-route-test-${crypto.randomUUID()}`);
    const execution = createNodePackageExecution();
    execution.prepare = async () => {
      throw new Error('private upstream credential and response');
    };
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, bytes, done) =>
      done(null, bytes),
    );
    await registerExtensionPackageRoutes(app, store, execution);
    try {
      const archive = await buildMoyaExtension({ manifest: examplePackageManifest(), source, license: 'test' });
      const payload = Buffer.from(await archive.arrayBuffer());
      const inspected = await app.inject({
        method: 'POST',
        url: '/api/extensions/packages/inspect',
        headers: binaryHeaders,
        payload,
      });
      const wrong = await app.inject({
        method: 'POST',
        url: `/api/extensions/packages/install?revision=0&digest=${'0'.repeat(64)}`,
        headers: binaryHeaders,
        payload,
      });
      expect(wrong.json()).toEqual({ error: 'package_approval_mismatch' });
      const failed = await app.inject({
        method: 'POST',
        url: `/api/extensions/packages/install?revision=0&digest=${inspected.json().package.digest}`,
        headers: binaryHeaders,
        payload,
      });
      expect(failed.json()).toEqual({ error: 'extension_operation_failed' });
      expect(await store.list()).toEqual([]);
    } finally {
      await app.close();
      await store.close();
    }
  });
});
