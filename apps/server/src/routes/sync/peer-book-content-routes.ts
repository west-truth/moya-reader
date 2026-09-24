import { Readable } from 'node:stream';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { BackupStaging } from '../../services/backup-staging.js';
import { exportHostedBackup } from '../../services/hosted-backup-service.js';
import { PeerBookContentError, restorePeerBookContent } from '../../services/peer-book-content.js';
import { UploadSpaceError } from '../../services/upload-file.js';

export async function registerPeerBookContentRoutes(app: FastifyInstance, pool: pg.Pool, config: ServerConfig) {
  const staging = new BackupStaging(path.join(config.dataDir, 'peer-book-staging'));
  const shutdown = new AbortController();
  let exporting = false;
  let receiving = false;
  app.addHook('preClose', async () => {
    shutdown.abort();
  });
  app.addHook('onClose', async () => {
    await staging.close();
  });
  app.get<{ Params: { bookId: string } }>('/api/sync/book-content/:bookId', async (request, reply) => {
    if (exporting) return reply.code(503).send({ error: 'peer_book_transfer_busy' });
    exporting = true;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, shutdown.signal, AbortSignal.timeout(60 * 60_000)]);
    reply.raw.once('close', () => abort.abort());
    try {
      const result = await exportHostedBackup(pool, config, signal, false, request.params.bookId);
      void result.completion
        .catch(() => undefined)
        .finally(() => {
          exporting = false;
        });
      return reply
        .header('Content-Type', 'application/zip')
        .header('Cache-Control', 'no-store')
        .send(Readable.fromWeb(result.readable as never));
    } catch (error) {
      exporting = false;
      if (error instanceof Error && error.message === 'peer_book_initial_content_required')
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/zip', (_request, payload, done) => done(null, payload));
    scope.post<{ Params: { bookId: string } }>('/api/sync/book-content/:bookId', async (request, reply) => {
      if (receiving) return reply.code(503).send({ error: 'peer_book_transfer_busy' });
      if (!(request.body instanceof Readable)) return reply.code(400).send({ error: 'peer_book_archive_required' });
      receiving = true;
      const abort = new AbortController();
      const signal = AbortSignal.any([abort.signal, shutdown.signal, AbortSignal.timeout(60 * 60_000)]);
      const disconnected = () => {
        if (!reply.raw.writableFinished) abort.abort();
      };
      request.raw.once('aborted', disconnected);
      reply.raw.once('close', disconnected);
      let stagedId: string | undefined;
      try {
        const length = request.headers['content-length'];
        const received = await staging.receive(request.body, length ? Number(length) : undefined, signal);
        stagedId = received.id;
        return await restorePeerBookContent(pool, config, received.stage.parsed, request.params.bookId, signal);
      } catch (error) {
        const storageUnavailable =
          error instanceof UploadSpaceError || (error as NodeJS.ErrnoException)?.code === 'ENOSPC';
        return reply
          .code(error instanceof PeerBookContentError ? 409 : storageUnavailable ? 503 : 400)
          .send({ error: error instanceof PeerBookContentError ? error.message : 'peer_book_archive_failed' });
      } finally {
        try {
          if (stagedId) await staging.discard(stagedId);
        } finally {
          receiving = false;
          request.raw.removeListener('aborted', disconnected);
          reply.raw.removeListener('close', disconnected);
        }
      }
    });
  });
}
