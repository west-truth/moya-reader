import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExternalSourceCredentialRecord } from '../contracts';
import type { ExternalSourceLocalState } from '../local-state';
import type { ExternalSourceSharedConnectionV1 } from '../../integration-settings/self-host-integration-settings';
import { createExternalSourceCredentialKey } from '../device-credential-crypto';
import { AppExternalSourceRegistry } from '../app-external-source-registry';
import { TextServerSourceAccountBroker } from './text-server-source-account-broker';
import { textServerNamespace } from './text-server-client';
import { TEXT_SERVER_EXTERNAL_SOURCE_ID, textServerBuiltInExternalSource } from './text-server-external-source';

async function removeFixtureDirectory(directory: string): Promise<void> {
  // Only the unique temporary fixture directory may be removed recursively.
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('moya-text-wire-')) {
    throw new Error('Unexpected fixture cleanup path');
  }
  await rm(resolved, { recursive: true, force: true });
}

describe('text source real HTTP protocol', () => {
  it('connects the production broker to the real server, paginates and preserves exact TXT bytes', async () => {
    // The standalone Node service is JavaScript; use its actual module without a fetch mock.
    const serviceUrl = new URL('../../../services/text-source-server/src/server.mjs', import.meta.url).href;
    const { createTextSourceServer } = (await import(/* @vite-ignore */ serviceUrl)) as {
      createTextSourceServer(options: {
        catalogFile: string;
        sourceRoot: string;
        serverKey: string;
        moyaOrigin: string;
      }): Promise<Server & { stop(): Promise<void> }>;
    };
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'moya-text-wire-'));
    let server: (Server & { stop(): Promise<void> }) | undefined;
    let broker: TextServerSourceAccountBroker | undefined;
    try {
      const originalBytes = new TextEncoder().encode('\ufeff합성 1화\r\n\u00a0  공백 보존  \r\n\r\n끝  ');
      await writeFile(path.join(temporaryDirectory, 'chapter.txt'), originalBytes);
      const releases = Array.from({ length: 51 }, (_, index) => ({
        id: `r${String(index).padStart(2, '0')}`,
        title: `${index + 1}화`,
        order: index,
        revision: `revision-${index}`,
        file: 'chapter.txt',
      }));
      const identity = { instanceId: 'wire-test-server', dataNamespace: 'synthetic-catalog' };
      const catalogFile = path.join(temporaryDirectory, 'catalog.json');
      await writeFile(
        catalogFile,
        JSON.stringify({
          ...identity,
          sources: [
            {
              id: 'source',
              name: '합성 소설',
              works: Array.from({ length: 51 }, (_, index) => ({
                id: `w${String(index).padStart(2, '0')}`,
                title: `합성 작품 ${index}`,
                author: '합성 작가',
                releases: index === 0 ? releases : [releases[0]],
              })),
            },
          ],
        }),
      );
      const serverKey = 'synthetic-wire-test-key-only';
      const moyaOrigin = 'https://moya.example.test';
      server = await createTextSourceServer({ catalogFile, sourceRoot: temporaryDirectory, serverKey, moyaOrigin });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(0, '127.0.0.1', resolve);
      });
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await fetch(`${endpoint}/v1/sources`, {
        headers: { Authorization: `Bearer ${serverKey}`, Origin: moyaOrigin },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Moya-Source-Namespace')).toBe(textServerNamespace(identity));
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(moyaOrigin);
      expect(response.headers.get('Access-Control-Expose-Headers')).toContain('ETag');
      expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Moya-Source-Namespace');
      await response.arrayBuffer();

      const credentialKey = await createExternalSourceCredentialKey();
      let credential: ExternalSourceCredentialRecord | undefined;
      let shared: ExternalSourceSharedConnectionV1 | undefined;
      const state = {
        getOrCreateCredentialKey: async () => credentialKey,
        getCredential: async () => credential,
        saveCredential: async (value: ExternalSourceCredentialRecord) => {
          credential = value;
        },
        deleteCredential: async () => {
          credential = undefined;
        },
        getSharedConnection: async () => shared,
        saveSharedConnection: async (value: ExternalSourceSharedConnectionV1) => {
          shared = value;
        },
        deleteSharedConnection: async () => {
          shared = undefined;
        },
        clearCache: async () => undefined,
      } as unknown as ExternalSourceLocalState;
      broker = new TextServerSourceAccountBroker(TEXT_SERVER_EXTERNAL_SOURCE_ID, state);
      const registry = new AppExternalSourceRegistry([textServerBuiltInExternalSource]);
      const context = { brokers: { get: () => broker } };
      await registry.connectExternalSource(TEXT_SERVER_EXTERNAL_SOURCE_ID, context, { endpoint, token: serverKey });
      expect(broker.status().state).toBe('connected');
      const accountConnectionId = broker.status().accountConnectionId;
      const signal = new AbortController().signal;
      const list = (parentRef?: string, cursor?: string) =>
        registry.listExternalSource(
          TEXT_SERVER_EXTERNAL_SOURCE_ID,
          context,
          { accountConnectionId, parentRef, cursor },
          signal,
        );
      const sources = await list();
      expect(sources.items.map((item) => item.title)).toEqual(['합성 소설']);
      const sourceRef = sources.items[0]!.navigationRef;
      const works = await list(sourceRef);
      expect(works.items).toHaveLength(50);
      expect(works.nextCursor).toEqual(expect.any(String));
      const lastWorks = await list(sourceRef, works.nextCursor);
      expect(lastWorks.items).toHaveLength(1);
      expect(lastWorks.nextCursor).toBeUndefined();
      const workRef = works.items[0]!.navigationRef;
      const firstReleases = await list(workRef);
      const lastReleases = await list(workRef, firstReleases.nextCursor);
      expect(firstReleases.items).toHaveLength(50);
      expect(lastReleases.items).toHaveLength(1);
      expect(lastReleases.nextCursor).toBeUndefined();
      const selected = lastReleases.items[0]!;
      expect(selected.release).toEqual({ title: '51화', sourceOrder: 50 });
      const downloaded = await registry.downloadExternalSource(
        TEXT_SERVER_EXTERNAL_SOURCE_ID,
        context,
        {
          key: selected.key,
          fileName: selected.importFileName!,
          remoteRevision: selected.remoteRevision,
          context: {
            expectedProfile: selected.collection!.seriesProfile,
            connectionGeneration: broker.status().connectionGeneration,
          },
        },
        signal,
      );
      expect(downloaded.content.kind).toBe('document');
      expect(downloaded.remoteRevision).toBe(selected.remoteRevision);
      expect(new Uint8Array(await downloaded.file.arrayBuffer())).toEqual(originalBytes);
      expect(downloaded.content.file).toBe(downloaded.file);
    } finally {
      broker?.dispose();
      await server?.stop();
      await removeFixtureDirectory(temporaryDirectory);
    }
  });
});
