import type { FastifyInstance } from 'fastify';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import { isExternalSeriesProfile } from '@noveldesk/extension-contracts';
import type { ExternalSourceRegistryPort } from '../../../../src/external-sources/app-external-source-registry.js';
import type {
  ExternalSourceCollectionDescriptorV2,
  ExternalSourceDownloadRef,
} from '../../../../src/external-sources/contracts.js';
import type {
  HostedDocumentAssembly,
  HostedDocumentAssemblyResult,
} from '../../../../src/services/import/hosted-document-import.js';
import type { PreparedServerImport } from '../../../../src/services/import/hosted-image-import.js';
import { assembleDocumentSeries } from '../../../../src/external-sources/series/document-series-assembler.js';
import { PreparedImageDownloads } from '../services/prepared-image-downloads.js';
import type { ReadDocumentSeriesSnapshot } from '../services/document-series-snapshot.js';
import type { ServerImportInput } from '../services/stage-server-import.js';
import type { registerPreparedSourceImages } from './prepared-source-images.js';

export interface ServerDocumentImports {
  read: ReadDocumentSeriesSnapshot;
  stage(file: File, input: ServerImportInput, signal: AbortSignal): Promise<PreparedServerImport>;
}
const context = { brokers: { get: () => undefined } };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const safeId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(v);
export function validHostedDocumentAssembly(v: unknown, sourceId: string): v is HostedDocumentAssembly {
  if (!record(v) || !safeId(v.artifactId) || !safeId(v.targetBookId) || !record(v.expectedBase) || !record(v.item))
    return false;
  if (
    v.expectedBase.kind !== 'absent' &&
    !(v.expectedBase.kind === 'revision' && safeId(v.expectedBase.contentRevisionId))
  )
    return false;
  const item = v.item;
  if (
    !record(item.key) ||
    item.key.connectorId !== sourceId ||
    !text(item.key.remoteId) ||
    (item.key.accountConnectionId !== undefined && !text(item.key.accountConnectionId)) ||
    !record(item.collection) ||
    !text(item.collection.remoteId) ||
    !text(item.collection.title, 1024) ||
    !isExternalSeriesProfile(item.collection.seriesProfile) ||
    item.collection.seriesProfile.kind !== 'document_series' ||
    !record(item.release) ||
    !text(item.release.title, 1024)
  )
    return false;
  for (const key of ['chapterNumber', 'sourceOrder']) {
    const number = item.release[key];
    if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number) || number < 0)) return false;
  }
  return (
    v.expectedPreviousSourceContentHash == null ||
    (typeof v.expectedPreviousSourceContentHash === 'string' &&
      /^(sha256:)?[a-f0-9]{64}$/i.test(v.expectedPreviousSourceContentHash))
  );
}

export function registerPreparedSourceDocuments(
  app: FastifyInstance,
  registry: ExternalSourceRegistryPort,
  refresh: () => Promise<unknown>,
  imports: ServerDocumentImports,
  handle: Parameters<typeof registerPreparedSourceImages>[4],
  withCancellation: Parameters<typeof registerPreparedSourceImages>[5],
) {
  const store = new PreparedImageDownloads(16 * 1024 * 1024);
  // At most two whole-book assemblies can occupy memory per owner/runtime.
  let assembling = 0;
  const status = (id: string) => {
    const result = registry.getExternalSourceStatus(id as ExtensionContributionId, context);
    if (result.state !== 'connected') throw new Error('package_source_unavailable');
    return result;
  };
  const generation = (id: string) => {
    const s = status(id);
    return JSON.stringify([s.accountConnectionId, s.connectionGeneration]);
  };
  app.addHook('onClose', async () => store.close());
  const prefix = '/api/extensions/sources/:id/prepared-documents';
  app.post<{ Params: { id: string } }>(prefix, { bodyLimit: 16 * 1024 }, (request, reply) =>
    handle(reply, () =>
      withCancellation(request, reply, async (signal) => {
        const body = request.body;
        const id = request.params.id;
        if (
          !record(body) ||
          !record(body.key) ||
          body.key.connectorId !== id ||
          !text(body.key.remoteId) ||
          !text(body.fileName, 1024)
        )
          return reply.code(400).send({ error: 'invalid_source_input' });
        await refresh();
        const before = generation(id);
        if ((body.key.accountConnectionId ?? '') !== (status(id).accountConnectionId ?? ''))
          throw new Error('package_source_unavailable');
        const result = await registry.downloadExternalSource(
          id as ExtensionContributionId,
          context,
          body as unknown as ExternalSourceDownloadRef,
          signal,
        );
        const content = result.content;
        if (
          content?.kind !== 'document' ||
          content.format !== 'txt' ||
          content.encoding !== 'utf-8' ||
          content.chapterSplitMode !== 'single' ||
          !content.file.size ||
          content.file.size > 2 * 1024 * 1024
        )
          throw new Error('invalid_source_assets');
        if (generation(id) !== before) throw new Error('prepared_download_unavailable');
        const receipt = await store.put(id, body.key.remoteId, content.file, signal, before);
        if (signal.aborted || generation(id) !== before) {
          store.discard(receipt.artifactId, id);
          signal.throwIfAborted();
          throw new Error('prepared_download_unavailable');
        }
        return { ...receipt, remoteRevision: result.remoteRevision };
      }),
    ),
  );
  app.post<{ Params: { id: string } }>(`${prefix}/assemble`, { bodyLimit: 32 * 1024 }, (request, reply) =>
    handle(reply, () =>
      withCancellation(request, reply, async (signal) => {
        const input = request.body;
        const id = request.params.id;
        if (!validHostedDocumentAssembly(input, id)) return reply.code(400).send({ error: 'invalid_source_input' });
        await refresh();
        const before = generation(id);
        if ((input.item.key.accountConnectionId ?? '') !== (status(id).accountConnectionId ?? ''))
          throw new Error('package_source_unavailable');
        if (assembling >= 2) throw new Error('execution_busy');
        assembling++;
        try {
          return await store.consume(
            input.artifactId,
            id,
            input.item.key.remoteId,
            async (file, sourceContentHash): Promise<HostedDocumentAssemblyResult> => {
              const base = await imports.read(input.targetBookId, input.expectedBase, signal);
              const { file: archive, ...result } = await assembleDocumentSeries({
                collection: input.item.collection as ExternalSourceCollectionDescriptorV2,
                targetBookId: input.targetBookId,
                expectedBase: input.expectedBase,
                existingSource: base.existingSource,
                signal,
                releases: [
                  {
                    item: input.item,
                    sourceContentHash,
                    expectedPreviousSourceContentHash: input.expectedPreviousSourceContentHash,
                    content: { kind: 'document', file, format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' },
                  },
                ],
              });
              signal.throwIfAborted();
              if (generation(id) !== before) throw new Error('prepared_download_unavailable');
              const prepared = archive
                ? await imports.stage(
                    archive,
                    {
                      clientBookId: input.targetBookId,
                      expectedBase: input.expectedBase,
                      encoding: 'utf-8',
                      chapterSplitMode: 'single',
                    },
                    signal,
                  )
                : undefined;
              const hash = prepared?.sourceContentHash ?? base.sourceContentHash;
              if (!hash) throw new Error('invalid_source_assets');
              return { ...result, prepared, sourceContentHash: hash };
            },
            before,
            true,
          );
        } finally {
          assembling--;
        }
      }),
    ),
  );
  app.delete<{ Params: { id: string; artifactId: string } }>(`${prefix}/:artifactId`, async (request) => {
    store.discard(request.params.artifactId, request.params.id);
    return { ok: true };
  });
}
