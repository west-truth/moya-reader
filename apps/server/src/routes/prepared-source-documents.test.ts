import 'fake-indexeddb/auto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDocumentSeriesArchive } from '@noveldesk/document-series-core';
import { integrityHash } from '@noveldesk/text-core/hash';
import { registerPreparedSourceDocuments } from './prepared-source-documents.js';
import { registerAuthHook } from '../auth.js';
import type { ServerConfig } from '../config.js';
import type { ServerImportInput } from '../services/stage-server-import.js';
import type { ExternalSourceRegistryPort } from '../../../../src/external-sources/app-external-source-registry.js';
import type { HostedDocumentImportPort } from '../../../../src/services/import/hosted-document-import.js';
import type { ImportService } from '../../../../src/services/import/import-service.js';
import type { Novel } from '../../../../src/domain/types.js';
import {
  importDocumentSeries,
  type DocumentSeriesImportOptions,
} from '../../../../src/external-sources/series/document-series-import-coordinator.js';
import {
  ExternalSourceLocalStateStore,
  resetExternalSourceLocalStateForTests,
} from '../../../../src/external-sources/local-state.js';
import { seriesDownloadRef } from '../../../../src/external-sources/series/series-download-queue.js';

afterEach(() => resetExternalSourceLocalStateForTests());
const sourceId = 'fixture.text';
const headers = { authorization: 'Bearer test-token' };
const prefix = `/api/extensions/sources/${sourceId}/prepared-documents`;
const item = (order: number): DocumentSeriesImportOptions['items'][number] => ({
  key: { connectorId: sourceId, accountConnectionId: 'account', remoteId: `release-${order}` },
  kind: 'file',
  title: `${order}화`,
  importability: 'supported',
  collection: {
    remoteId: 'work',
    title: '범용 텍스트',
    seriesProfile: { kind: 'document_series', format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' },
  },
  release: { title: `${order}화`, sourceOrder: order },
});
const raw = (id: string) => `\uFEFF${id} 첫 문단.\r\n\r\n들여쓰기  둘째 문단.\r\n`;

async function fixture() {
  const app = Fastify();
  await registerAuthHook(app, { host: '127.0.0.1', authToken: 'test-token' } as ServerConfig);
  let generation = 'one';
  let source: File | undefined;
  let novel: Novel | undefined;
  let revision = 0;
  const staged = new Map<string, { file: File; input: ServerImportInput }>();
  const bodies = new Map<string, string>();
  const download = vi.fn(async (_id, _context, ref) => {
    const file = new File([bodies.get(ref.key.remoteId) ?? raw(ref.key.remoteId)], `${ref.key.remoteId}.txt`);
    return { file, content: { kind: 'document', file, format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' } };
  });
  const registry = {
    getExternalSourceStatus: () => ({
      state: 'connected',
      connectionGeneration: generation,
      accountConnectionId: 'account',
    }),
    downloadExternalSource: download,
  } as unknown as ExternalSourceRegistryPort;
  const checkBase = (expected: ServerImportInput['expectedBase']) => {
    if (
      expected?.kind === 'absent'
        ? Boolean(novel)
        : expected?.kind !== 'revision' || expected.contentRevisionId !== novel?.activeContentRevisionId
    )
      throw new Error('import_expected_base_conflict');
  };
  const stage = vi.fn(async (file: File, input: ServerImportInput) => {
    const uploadId = `upload-${staged.size}-${crypto.randomUUID()}`;
    staged.set(uploadId, { file, input });
    return {
      uploadId,
      sourceContentHash: integrityHash(new Uint8Array(await file.arrayBuffer())),
      byteLength: file.size,
    };
  });
  registerPreparedSourceDocuments(
    app,
    registry,
    async () => {},
    {
      read: async (_bookId, expected) => {
        checkBase(expected);
        return { existingSource: source ? { blob: source } : undefined, sourceContentHash: novel?.sourceContentHash };
      },
      stage,
    },
    async (reply, run) => {
      try {
        return await run();
      } catch (error) {
        return reply.code(422).send({ error: (error as Error).message });
      }
    },
    (_request, _reply, run) => run(new AbortController().signal),
  );
  const request = async (path: string, payload?: unknown, method: 'POST' | 'DELETE' = 'POST') => {
    const response = await app.inject({
      method,
      url: prefix + path,
      headers,
      ...(payload ? { payload: payload as object } : {}),
    });
    if (response.statusCode !== 200) throw new Error(response.json().error);
    return response.json();
  };
  const port: HostedDocumentImportPort = {
    download: vi.fn((ref) => request('', ref)),
    assemble: vi.fn((input) => request('/assemble', input)),
    discard: vi.fn(async (id) => {
      await request(`/${id}`, undefined, 'DELETE');
    }),
    cancelPrepared: vi.fn(async (id) => {
      staged.delete(id);
    }),
  };
  const state = new ExternalSourceLocalStateStore();
  const commit = vi.fn<NonNullable<ImportService['importPrepared']>>((receipt) => ({
    jobId: 'fixture-job',
    cancel: vi.fn(),
    promise: (async () => {
      const data = staged.get(receipt.uploadId)!;
      checkBase(data.input.expectedBase);
      source = data.file;
      novel = {
        ...novel,
        id: data.input.clientBookId,
        format: 'txt',
        sourceContentHash: receipt.sourceContentHash,
        activeContentRevisionId: `revision-${++revision}`,
        lastReadOffset: novel?.lastReadOffset ?? 17,
      } as Novel;
      return { novel };
    })(),
  }));
  const importFile = vi.fn();
  const assets = {
    exportSource: vi.fn(() => {
      throw new Error('Browser must not export the whole book');
    }),
  } as unknown as NonNullable<DocumentSeriesImportOptions['assets']>;
  const onCommitted = vi.fn(async () => {});
  const abort = new AbortController();
  const options = (items: DocumentSeriesImportOptions['items']): DocumentSeriesImportOptions => ({
    sourceId,
    items,
    registry,
    hostContext: { brokers: { get: () => undefined } },
    state,
    assets,
    importService: { supportsExpectedBase: true, importFile, importPrepared: commit },
    getNovel: async () => novel,
    signal: abort.signal,
    onProgress: vi.fn(),
    onCommitted,
    hosted: { port, download: (selected) => port.download(seriesDownloadRef(selected, generation), abort.signal) },
  });
  return {
    app,
    request,
    port,
    download,
    stage,
    commit,
    options,
    state,
    assets,
    importFile,
    onCommitted,
    abort,
    bodies,
    run: (items: DocumentSeriesImportOptions['items']) => importDocumentSeries(options(items)),
    source: () => source,
    novel: () => novel,
    changeGeneration: () => {
      generation = 'two';
    },
    concurrentRevision: () => {
      if (novel) novel.activeContentRevisionId = `revision-${++revision}`;
    },
  };
}

describe('hosted installed document imports', () => {
  it('releases committed receipts during a batch longer than the staging capacity', async () => {
    const f = await fixture();
    try {
      await f.run(Array.from({ length: 10 }, (_, i) => item(i + 1)));
      expect(f.commit).toHaveBeenCalledTimes(10);
      expect(f.port.discard).toHaveBeenCalledTimes(10);
    } finally {
      await f.app.close();
    }
  });
  it('rejects a changed same-release base when retrying a previously assembled update', async () => {
    const f = await fixture();
    try {
      await f.run([item(1)]);
      const receipt = await f.port.download(seriesDownloadRef(item(1)), f.abort.signal);
      const previousHash = integrityHash(raw('release-1'));
      f.bodies.set('release-1', 'A concurrent revision changed this release.');
      await f.run([item(1)]);
      await expect(
        f.port.assemble(
          {
            artifactId: receipt.artifactId,
            item: item(1),
            targetBookId: f.novel()!.id,
            expectedBase: { kind: 'revision', contentRevisionId: f.novel()!.activeContentRevisionId! },
            expectedPreviousSourceContentHash: previousHash,
          },
          f.abort.signal,
        ),
      ).rejects.toThrow('기존 본문이 변경');
      expect(f.commit).toHaveBeenCalledTimes(2);
    } finally {
      await f.app.close();
    }
  });
  it('passes only receipts across HTTP, preserves raw bytes and commits each release in order without browser export/upload', async () => {
    const f = await fixture();
    try {
      await f.run([item(1), item(2), item(3)]);
      expect(f.onCommitted).toHaveBeenCalledTimes(3);
      expect(f.port.discard).toHaveBeenCalledTimes(3);
      expect(f.assets.exportSource).not.toHaveBeenCalled();
      expect(f.importFile).not.toHaveBeenCalled();
      expect(f.novel()?.lastReadOffset).toBe(17);
      const archive = (await readDocumentSeriesArchive(f.source()!))!;
      expect(archive.manifest.sources.map((s) => s.title)).toEqual(['1화', '2화', '3화']);
      for (const descriptor of archive.manifest.sources) {
        const order = descriptor.sourceOrder;
        expect(new Uint8Array(await archive.sources.get(descriptor.id)!.arrayBuffer())).toEqual(
          new TextEncoder().encode(raw(`release-${order}`)),
        );
      }
      expect(f.stage.mock.calls[1]![1].expectedBase).toEqual({ kind: 'revision', contentRevisionId: 'revision-1' });
      const links = await f.state.listLinks(sourceId);
      expect(links).toHaveLength(3);
      expect(links.every((link) => !link.pendingImport)).toBe(true);
      const count = f.commit.mock.calls.length;
      await f.run([item(3)]);
      expect(f.commit).toHaveBeenCalledTimes(count);
      expect(f.port.cancelPrepared).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });

  it('retains a receipt across a stale-base retry without downloading twice', async () => {
    const f = await fixture();
    try {
      await f.run([item(1)]);
      const original = f.port.assemble;
      f.port.assemble = vi.fn(async (input, signal) => {
        f.concurrentRevision();
        f.port.assemble = original;
        return original(input, signal);
      });
      await f.run([item(2)]);
      expect(f.download).toHaveBeenCalledTimes(2);
      expect(f.commit).toHaveBeenCalledTimes(2);
      expect((await readDocumentSeriesArchive(f.source()!))?.manifest.sources).toHaveLength(2);
    } finally {
      await f.app.close();
    }
  });

  it('cancels an unused staged upload if abort arrives after server assembly', async () => {
    const f = await fixture();
    try {
      const original = f.port.assemble;
      f.port.assemble = async (input, signal) => {
        const result = await original(input, signal);
        f.abort.abort();
        return result;
      };
      await expect(f.run([item(1)])).rejects.toThrow();
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.port.cancelPrepared).toHaveBeenCalledOnce();
      expect(f.port.discard).toHaveBeenCalledOnce();
      expect(await f.state.listLinks()).toEqual([]);
    } finally {
      await f.app.close();
    }
  });

  it('requires authentication and rejects malformed, foreign-account and expired-generation receipts', async () => {
    const f = await fixture();
    try {
      expect(
        (await f.app.inject({ method: 'POST', url: prefix, payload: seriesDownloadRef(item(1)) })).statusCode,
      ).toBe(401);
      const receipt = await f.port.download(seriesDownloadRef(item(1)), f.abort.signal);
      expect(receipt).not.toHaveProperty('file');
      const assembly = {
        artifactId: receipt.artifactId,
        item: item(1),
        targetBookId: 'book',
        expectedBase: { kind: 'absent' as const },
      };
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `${prefix}/assemble`,
            headers,
            payload: { ...assembly, targetBookId: '../escape' },
          })
        ).statusCode,
      ).toBe(400);
      await expect(
        f.port.assemble(
          { ...assembly, item: { ...item(1), key: { ...item(1).key, accountConnectionId: 'other' } } },
          f.abort.signal,
        ),
      ).rejects.toThrow();
      f.changeGeneration();
      await expect(f.port.assemble(assembly, f.abort.signal)).rejects.toThrow('prepared_download_unavailable');
      expect(f.stage).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
});
