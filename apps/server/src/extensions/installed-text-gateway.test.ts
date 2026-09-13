import 'fake-indexeddb/auto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createInstalledTextGateway, parseInstalledTextMigration } from './installed-text-gateway.js';
import { registerExtensionPackageRoutes } from '../routes/extension-packages.js';
import { registerTextSourceGateway } from '../routes/text-source-gateway.js';
import { createNodePackageExecution } from './node-package-execution.js';
import { loadConfig } from '../config.js';
import { IndexedDbPackageInstallStore } from '../../../../src/extensions/packages/package-install-store.js';
import { buildMoyaExtension } from '../../../../src/extensions/packages/package-builder.js';
import { examplePackageManifest } from '../../../../src/test/extension-package-fixture.js';
import { TextServerSourceAccountBroker } from '../../../../src/external-sources/text-server/text-server-source-account-broker.js';
import { TEXT_SERVER_EXTERNAL_SOURCE_ID } from '../../../../src/external-sources/text-server/text-server-external-source.js';
import type { ExternalSourceLocalState } from '../../../../src/external-sources/local-state.js';
import {
  externalDocumentCollectionId,
  externalDocumentReleaseSourceId,
} from '../../../../src/external-sources/series/document-series-identity.js';

const sourceId = 'org.example.catalog.source';
const identity = { instanceId: 'existing-instance', dataNamespace: 'existing-library', accountId: 'existing-owner' };
const migration = { identity, sources: [{ legacyId: 'original', packageId: 'org.example.catalog', sourceId }] };
const original = new Uint8Array([239, 187, 191, ...new TextEncoder().encode('원문\r\n  그대로  \n')]);
const code = `globalThis.moyaExtension=async(method,input)=>{
 if(method==='describe')return{apiVersion:1,sources:[{id:'${sourceId}',cover:false}]};
 if(method==='source.listWorks')return{items:[{id:'work',title:'Work'}]};
 if(method==='source.getWork')return{id:'work',title:'Work'};
 if(method==='source.listReleases')return{items:[{id:'one',title:'One',order:1}]};
 if(method==='source.getContent')return{kind:'service',service:'text-content',version:1,url:'https://catalog.example/work/one'};
};`;

describe('installed text migration', () => {
  it('preserves old identities and raw text through the existing broker without a companion server', async () => {
    const app = Fastify();
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    const store = new IndexedDbPackageInstallStore('text-migration-' + crypto.randomUUID());
    const resolver = vi.fn(async () => original);
    const catalog = await registerExtensionPackageRoutes(
      app,
      store,
      createNodePackageExecution('self-host-gateway', { contentResolver: resolver, contentConfigured: () => true }),
      undefined,
      undefined,
      new Set([sourceId]),
    );
    const legacyNetwork = vi.fn<typeof fetch>();
    await registerTextSourceGateway(app, loadConfig({}), {
      installedFetch: createInstalledTextGateway(catalog, migration),
      fetchImpl: legacyNetwork,
    });
    const manifest = examplePackageManifest();
    const archive = await buildMoyaExtension({
      manifest: {
        ...manifest,
        requestedAccess: {
          ...manifest.requestedAccess,
          contentServices: [{ sourceId, version: 1, origins: ['https://catalog.example'] }],
        },
      },
      source: code,
      license: 'test',
    });
    let credential: unknown, shared: unknown;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const state = {
      getOrCreateCredentialKey: async () => key,
      getCredential: async () => credential,
      saveCredential: async (value: unknown) => {
        credential = value;
      },
      getSharedConnection: async () => shared,
      saveSharedConnection: async (value: unknown) => {
        shared = value;
      },
      clearCache: async () => undefined,
    } as unknown as ExternalSourceLocalState;
    const managedFetch = async (path: string) => {
      const response = await app.inject('/api/integrations/text-sources' + path);
      return new Response(Uint8Array.from(response.rawPayload), {
        status: response.statusCode,
        headers: response.headers as HeadersInit,
      });
    };
    let broker = new TextServerSourceAccountBroker(TEXT_SERVER_EXTERNAL_SOURCE_ID, state, { managedFetch });
    try {
      const payload = Buffer.from(await archive.arrayBuffer()),
        headers = { 'content-type': 'application/octet-stream' };
      const review = (
        await app.inject({ method: 'POST', url: '/api/extensions/packages/inspect', headers, payload })
      ).json();
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/extensions/packages/install?revision=${review.expectedRevision}&digest=${review.package.digest}`,
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(200);
      expect((await app.inject('/api/extensions/packages')).json().sources).toEqual([]);
      const previous = new TextServerSourceAccountBroker(TEXT_SERVER_EXTERNAL_SOURCE_ID, state, {
        managedFetch: async () =>
          new Response(JSON.stringify({ ...identity, protocolVersion: 1, capabilities: ['catalog', 'txt-content'] }), {
            headers: { 'Content-Type': 'application/json' },
          }),
      });
      await previous.connect();
      const previousAccount = previous.status().accountConnectionId;
      previous.dispose();
      await broker.initialize();
      const account = broker.status().accountConnectionId;
      expect(account).toBe(previousAccount);
      const connection = (
        await app.inject({
          method: 'POST',
          url: `/api/extensions/sources/${sourceId}/content-connection`,
          payload: { action: 'status' },
        })
      ).json();
      expect(connection).toEqual({ configured: true, managed: true });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/extensions/sources/${sourceId}/content-connection`,
            payload: { action: 'save', endpoint: 'http://localhost:9870' },
          })
        ).statusCode,
      ).not.toBe(200);
      const signal = new AbortController().signal;
      const page = await broker.list({ parentRef: 'text:["original","work"]', accountConnectionId: account }, signal);
      const item = page.items[0];
      expect(item.key.remoteId).toBe('text:["original","work","one"]');
      const oldKey = {
        connectorId: TEXT_SERVER_EXTERNAL_SOURCE_ID,
        accountConnectionId: account,
        remoteId: 'text:["original","work","one"]',
      };
      const oldCollection = 'text:["original","work"]';
      expect(externalDocumentCollectionId(item.key, item.collection!.remoteId)).toBe(
        externalDocumentCollectionId(oldKey, oldCollection),
      );
      expect(externalDocumentReleaseSourceId(item.key, item.collection!.remoteId)).toBe(
        externalDocumentReleaseSourceId(oldKey, oldCollection),
      );
      const result = await broker.download({ key: item.key, fileName: 'one.txt' }, signal);
      expect(new Uint8Array(await result.content.file.arrayBuffer())).toEqual(original);
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(result.remoteRevision).toMatch(/^"[a-f0-9]{64}"$/);
      broker.dispose();
      broker = new TextServerSourceAccountBroker(TEXT_SERVER_EXTERNAL_SOURCE_ID, state, { managedFetch });
      await broker.initialize();
      expect(broker.status().accountConnectionId).toBe(account);
      expect(
        (await broker.list({ parentRef: oldCollection, accountConnectionId: account }, signal)).items[0].key,
      ).toEqual(item.key);
      expect(legacyNetwork).not.toHaveBeenCalled();
      await catalog.disable(sourceId);
      expect((await app.inject('/api/integrations/text-sources/v1/sources/original/works/work')).statusCode).toBe(503);
      expect(new Uint8Array(await result.content.file.arrayBuffer())).toEqual(original);
    } finally {
      broker.dispose();
      await app.close();
    }
  });
  it('requires explicit, unambiguous operator identities and source ownership', () => {
    expect(parseInstalledTextMigration(undefined)).toBeUndefined();
    expect(parseInstalledTextMigration(JSON.stringify(migration))).toEqual(migration);
    expect(() =>
      parseInstalledTextMigration(
        JSON.stringify({ ...migration, sources: [...migration.sources, ...migration.sources] }),
      ),
    ).toThrow('invalid_installed_text_migration');
    expect(() =>
      parseInstalledTextMigration(
        JSON.stringify({ ...migration, sources: [{ ...migration.sources[0], sourceId: 'other.source' }] }),
      ),
    ).toThrow('invalid_installed_text_migration');
  });
});
