import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { ExternalSourceRegistryPort } from '../../../../src/external-sources/app-external-source-registry.js';
import type { ExternalSourceDownloadRef } from '../../../../src/external-sources/contracts.js';
import type { HostedImageAssembly, PreparedServerImport } from '../../../../src/services/import/hosted-image-import.js';
import { buildSeriesImageArchive } from '@noveldesk/fixed-document-core/series-image-archive';
import { openImageArchiveStream } from '@noveldesk/fixed-document-core';
import { PreparedImageDownloads } from '../services/prepared-image-downloads.js';

export type StageServerImageImport = (
  file: File,
  input: HostedImageAssembly,
  signal: AbortSignal,
) => Promise<PreparedServerImport>;
const context = { brokers: { get: () => undefined } };
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value);

export function validHostedImageAssembly(body: unknown): body is HostedImageAssembly {
  if (
    !record(body) ||
    !safeId(body.artifactId) ||
    !safeId(body.clientBookId) ||
    !text(body.remoteId, 4096) ||
    !record(body.collection) ||
    !text(body.collection.remoteId, 4096) ||
    !text(body.collection.title, 1024) ||
    !record(body.release) ||
    !text(body.release.title, 1024)
  )
    return false;
  if (body.importMode !== undefined && body.importMode !== 'replace_book' && body.importMode !== 'append_image_series')
    return false;
  if (body.importMode === 'append_image_series' && !safeId(body.baseActiveContentRevisionId)) return false;
  if (body.baseActiveContentRevisionId !== undefined && !safeId(body.baseActiveContentRevisionId)) return false;
  if (
    body.expectedPreviousSourceContentHash !== undefined &&
    (typeof body.expectedPreviousSourceContentHash !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(body.expectedPreviousSourceContentHash))
  )
    return false;
  if (body.remoteRevision !== undefined && !text(body.remoteRevision, 4096)) return false;
  for (const key of ['chapterNumber', 'sourceOrder']) {
    const value = body.release[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return false;
  }
  return true;
}

export function registerPreparedSourceImages(
  app: FastifyInstance,
  registry: ExternalSourceRegistryPort,
  refresh: () => Promise<unknown>,
  stage: StageServerImageImport,
  handle: <T>(reply: FastifyReply, run: () => Promise<T>) => Promise<unknown>,
  withCancellation: <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    run: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>,
) {
  const store = new PreparedImageDownloads();
  const generation = (id: string) => {
    const status = registry.getExternalSourceStatus(id as ExtensionContributionId, context);
    if (status.state !== 'connected') throw new Error('package_source_unavailable');
    return JSON.stringify([status.accountConnectionId, status.connectionGeneration]);
  };
  app.addHook('onClose', async () => store.close());
  const prefix = '/api/extensions/sources/:id/prepared-images';
  app.post<{ Params: { id: string } }>(prefix, { bodyLimit: 16 * 1024 }, (request, reply) =>
    handle(reply, () =>
      withCancellation(request, reply, async (signal) => {
        const body = request.body;
        if (
          !record(body) ||
          !record(body.key) ||
          body.key.connectorId !== request.params.id ||
          !text(body.key.remoteId, 4096) ||
          !text(body.fileName, 1024)
        )
          return reply.code(400).send({ error: 'invalid_source_input' });
        await refresh();
        const before = generation(request.params.id);
        const result = await registry.downloadExternalSource(
          request.params.id as ExtensionContributionId,
          context,
          body as unknown as ExternalSourceDownloadRef,
          signal,
        );
        if (result.content?.kind !== 'image_archive') return reply.code(422).send({ error: 'invalid_source_assets' });
        const receipt = await store.put(request.params.id, body.key.remoteId, result.file, signal, before);
        if (signal.aborted) {
          store.discard(receipt.artifactId, request.params.id);
          signal.throwIfAborted();
        }
        return { ...receipt, remoteRevision: result.remoteRevision };
      }),
    ),
  );
  app.post<{ Params: { id: string } }>(`${prefix}/assemble`, { bodyLimit: 32 * 1024 }, (request, reply) =>
    handle(reply, () =>
      withCancellation(request, reply, async (signal) => {
        const body = request.body;
        if (!validHostedImageAssembly(body)) return reply.code(400).send({ error: 'invalid_source_input' });
        // Check the source is still installed before consuming its one-use receipt.
        await refresh();
        if (
          registry.getExternalSourceStatus(request.params.id as ExtensionContributionId, context).state !== 'connected'
        )
          throw new Error('package_source_unavailable');
        const before = generation(request.params.id);
        return store.consume(
          body.artifactId,
          request.params.id,
          body.remoteId,
          async (file, sourceContentHash) => {
            const archive = await buildSeriesImageArchive({
              openImageArchiveStream,
              collection: body.collection,
              targetBookId: body.importMode === 'append_image_series' ? body.clientBookId : undefined,
              chapters: [
                {
                  file,
                  remoteId: body.remoteId,
                  release: body.release,
                  remoteRevision: body.remoteRevision,
                  sourceContentHash,
                  expectedPreviousSourceContentHash: body.expectedPreviousSourceContentHash,
                },
              ],
              signal,
            });
            signal.throwIfAborted();
            if (generation(request.params.id) !== before) throw new Error('prepared_download_unavailable');
            return stage(archive, body, signal);
          },
          before,
        );
      }),
    ),
  );
  app.delete<{ Params: { id: string; artifactId: string } }>(`${prefix}/:artifactId`, async (request) => {
    store.discard(request.params.artifactId, request.params.id);
    return { ok: true };
  });
}
