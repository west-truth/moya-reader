import { Readable } from 'node:stream';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { BackupStaging } from '../../services/backup-staging.js';
import { exportHostedBackup } from '../../services/hosted-backup-service.js';
import {
  parsePeerBookContentChange,
  parsePeerBookContentChain,
  PeerBookContentError,
  restorePeerBookContent,
  restorePeerBookReplacement,
} from '../../services/peer-book-content.js';
import type { PeerBookContentChain } from '../../services/peer-book-content.js';
import type { BookImportContentChangeV1 } from '@noveldesk/contracts/sync';
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
  app.get<{ Params: { bookId: string }; Querystring: { revision?: string } }>(
    '/api/sync/book-content/:bookId',
    async (request, reply) => {
      const revision = request.query.revision;
      if (revision !== undefined && !/^[A-Za-z0-9:_-]{1,512}$/.test(revision))
        return reply.code(400).send({ error: 'peer_book_revision_invalid' });
      if (exporting) return reply.code(503).send({ error: 'peer_book_transfer_busy' });
      exporting = true;
      const abort = new AbortController();
      const signal = AbortSignal.any([abort.signal, shutdown.signal, AbortSignal.timeout(60 * 60_000)]);
      reply.raw.once('close', () => abort.abort());
      try {
        const result = await exportHostedBackup(pool, config, signal, false, request.params.bookId, revision);
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
        if (
          error instanceof Error &&
          ['peer_book_initial_content_required', 'peer_book_revision_changed'].includes(error.message)
        )
          return reply.code(409).send({ error: error.message });
        throw error;
      }
    },
  );
  async function receiveContent(
    request: FastifyRequest<{ Params: { bookId: string } }>,
    reply: FastifyReply,
    change?: BookImportContentChangeV1,
    chain?: PeerBookContentChain,
  ) {
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
      if (received.stage.source !== 'hosted') throw new PeerBookContentError('peer_book_content_scope_invalid');
      return change
        ? await restorePeerBookReplacement(
            pool,
            config,
            received.stage.parsed,
            request.params.bookId,
            signal,
            change,
            chain,
          )
        : await restorePeerBookContent(
            pool,
            config,
            received.stage.parsed,
            request.params.bookId,
            signal,
            undefined,
            chain,
          );
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
  }
  await app.register(async (scope) => {
    const parseChainHeader = (encoded: unknown): PeerBookContentChain | undefined => {
      if (encoded === undefined) return undefined;
      if (typeof encoded !== 'string' || encoded.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(encoded))
        throw new PeerBookContentError('peer_book_change_chain_invalid');
      return parsePeerBookContentChain(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
    };
    // Production has a bounded ZIP parser for other routes. Override it only
    // in this streaming scope, as the existing backup routes do.
    if (scope.hasContentTypeParser('application/zip')) scope.removeContentTypeParser('application/zip');
    scope.addContentTypeParser('application/zip', (_request, payload, done) => done(null, payload));
    scope.post<{ Params: { bookId: string } }>('/api/sync/book-content/:bookId', (request, reply) => {
      try {
        return receiveContent(request, reply, undefined, parseChainHeader(request.headers['x-moya-content-chain']));
      } catch {
        return reply.code(400).send({ error: 'peer_book_change_chain_invalid' });
      }
    });
    scope.post<{ Params: { bookId: string } }>('/api/sync/book-replacement/:bookId', (request, reply) => {
      const encoded = request.headers['x-moya-content-change'];
      if (typeof encoded !== 'string' || encoded.length > 3_072 || !/^[A-Za-z0-9_-]+$/.test(encoded))
        return reply.code(400).send({ error: 'peer_book_content_change_invalid' });
      try {
        const change = parsePeerBookContentChange(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
        const chain = parseChainHeader(request.headers['x-moya-content-chain']);
        return receiveContent(request, reply, change, chain);
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof PeerBookContentError ? error.message : 'peer_book_content_change_invalid',
        });
      }
    });
  });
}
