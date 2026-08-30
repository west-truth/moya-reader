import Fastify, { FastifyInstance, type FastifyError } from 'fastify';
import { assertSecureServerConfig, corsAllowedOrigins, type ServerConfig } from './config.js';
import { createPool, seedDefaultUser } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createImportQueue, createProviderQueue } from './queue.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerUploadRoutes } from './routes/uploads.js';
import { registerBookRoutes } from './routes/books.js';
import { registerAIRoutes } from './routes/ai.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerBackupRoutes } from './routes/backups.js';
import { registerSelfHostAuthRoutes } from './routes/auth.js';
import { registerWebNovelMetadataCollectorGateway } from './routes/webnovel-metadata-collector-gateway.js';
import { pruneStaleUploadSessions } from './services/upload-cleanup.js';
import { registerAuthHook } from './auth.js';
import { PostgresSelfHostAuthStore, SelfHostAuthService } from './services/self-host-auth-service.js';
import { createS3Client, ensureBucket } from './services/object-storage.js';
import {
  createStructuredLogger,
  metricsFromQueue,
  registerMetricsRoute,
  registerRequestObservability,
} from './observability/index.js';

const corsMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const uploadPruneIntervalMs = 6 * 60 * 60 * 1000;
const corsHeaders = [
  'content-type',
  'authorization',
  'x-request-id',
  'x-correlation-id',
  'x-backup-default-resolution',
  'x-backup-conflict-resolutions',
  'x-source-file-name',
  'x-source-content-type',
  'range',
  'if-range',
  'x-expected-metadata-revision',
  'x-expected-content-revision-id',
  'x-cover-file-name',
  'x-cover-content-type',
  'x-cover-content-hash',
  'x-cover-width',
  'x-cover-height',
  'x-cover-fit',
  'x-cover-position-x',
  'x-cover-position-y',
  'x-cover-provenance',
  'x-font-content-type',
  'x-font-content-hash',
  'x-font-family',
  'x-font-file-name',
  'x-font-style',
  'x-font-weight',
  'x-font-license-note',
] as const;

function requestedCorsHeaders(value: string | string[] | undefined): string[] {
  const header = Array.isArray(value) ? value.join(',') : value;
  return header
    ? header
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    : [];
}

function preflightAllowed(requestedMethod: string | undefined, requestedHeaders: readonly string[]): boolean {
  const methodAllowed =
    !requestedMethod || corsMethods.includes(requestedMethod.trim().toUpperCase() as (typeof corsMethods)[number]);
  return (
    methodAllowed && requestedHeaders.every((header) => corsHeaders.includes(header as (typeof corsHeaders)[number]))
  );
}

function sameOriginHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

export function registerCorsPolicy(app: FastifyInstance, config: ServerConfig): void {
  const allowedOrigins = new Set(corsAllowedOrigins(config));

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin) return;

    reply.header('Vary', 'Origin');
    // Same-origin browser traffic is not CORS and must keep working when the
    // self-host is reached through a private DNS name or reverse proxy. Exact
    // allowlisting remains mandatory for genuinely cross-origin clients.
    if (!allowedOrigins.has(origin) && !sameOriginHost(origin, request.headers.host)) {
      return reply.code(403).send({ error: 'cors_origin_denied' });
    }

    const requestedHeaders = requestedCorsHeaders(request.headers['access-control-request-headers']);
    if (
      request.method.toUpperCase() === 'OPTIONS' &&
      !preflightAllowed(request.headers['access-control-request-method'], requestedHeaders)
    ) {
      return reply.code(403).send({ error: 'cors_preflight_denied' });
    }

    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Methods', corsMethods.join(','));
    reply.header(
      'Access-Control-Allow-Headers',
      'Content-Type,Authorization,Range,If-Range,X-Request-Id,X-Correlation-Id,X-Backup-Default-Resolution,X-Backup-Conflict-Resolutions,X-Source-File-Name,X-Source-Content-Type,X-Expected-Metadata-Revision,X-Expected-Content-Revision-Id,X-Cover-File-Name,X-Cover-Content-Type,X-Cover-Content-Hash,X-Cover-Width,X-Cover-Height,X-Cover-Fit,X-Cover-Position-X,X-Cover-Position-Y,X-Cover-Provenance,X-Font-Content-Type,X-Font-Content-Hash,X-Font-Family,X-Font-File-Name,X-Font-Style,X-Font-Weight,X-Font-License-Note',
    );
    reply.header(
      'Access-Control-Expose-Headers',
      'X-Request-Id,X-Correlation-Id,X-Asset-Id,X-Asset-Kind,X-Asset-Provenance,X-Asset-Status,X-Asset-File-Name,X-Asset-Content-Hash,X-Asset-Pixel-Width,X-Asset-Pixel-Height,X-Asset-Created-At,X-Asset-Activated-At,X-Page-Index,X-Source-File-Name,X-Source-Content-Hash,X-Content-Revision-Id,Accept-Ranges,Content-Range,Content-Length,Content-Disposition,ETag',
    );
    reply.header('Access-Control-Max-Age', '600');
  });

  app.options('/*', async (_request, reply) => reply.code(204).send());
}

export function registerSafeErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const statusCode = Number.isInteger(error.statusCode) ? Number(error.statusCode) : 500;
    if (statusCode < 500) {
      return reply.code(statusCode).send({
        error: error.message,
        ...(typeof error.code === 'string' ? { code: error.code } : undefined),
      });
    }
    const requestId = reply.getHeader('x-request-id');
    return reply.code(500).send({
      error: '서버 요청을 처리하지 못했습니다.',
      code: 'internal_server_error',
      ...(typeof requestId === 'string' && requestId ? { requestId } : undefined),
    });
  });
}

export async function buildServer(config: ServerConfig): Promise<FastifyInstance> {
  assertSecureServerConfig(config);

  if (config.runMigrationsOnStart) {
    await runMigrations();
  }

  const pool = createPool(config);
  await seedDefaultUser(pool, config.defaultUserId);
  const importQueue = createImportQueue(config);
  const providerQueue = createProviderQueue(config);
  const objectStorage = createS3Client(config);
  const logger = createStructuredLogger({ service: 'api' });
  const metrics = metricsFromQueue(providerQueue, logger);

  const app = Fastify({
    bodyLimit: config.maxChunkBytes,
    disableRequestLogging: true,
    loggerInstance: logger.fastify,
    // A numeric hop count avoids trusting arbitrary client-supplied forwarding chains.
    trustProxy: config.trustedProxyHops ? config.trustedProxyHops : false,
  });

  registerRequestObservability(app, logger);
  registerSafeErrorHandler(app);

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser('application/zip', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  registerCorsPolicy(app, config);

  const selfHostAuth = new SelfHostAuthService(new PostgresSelfHostAuthStore(pool), config.defaultUserId);
  await registerAuthHook(app, config, selfHostAuth);
  await registerSelfHostAuthRoutes(app, selfHostAuth, config);

  const pruneResult = await pruneStaleUploadSessions(pool, config);
  if (pruneResult.prunedCount) {
    logger.info('stale_upload_sessions_pruned', { prunedCount: pruneResult.prunedCount });
  }

  let uploadPrunePromise: Promise<void> | undefined;
  const runScheduledUploadPrune = () => {
    if (uploadPrunePromise) return;
    uploadPrunePromise = pruneStaleUploadSessions(pool, config)
      .then((result) => {
        if (result.prunedCount) logger.info('stale_upload_sessions_pruned', { prunedCount: result.prunedCount });
      })
      .catch((error) => {
        logger.warn('stale_upload_session_prune_failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      })
      .finally(() => {
        uploadPrunePromise = undefined;
      });
  };
  const uploadPruneTimer = setInterval(runScheduledUploadPrune, uploadPruneIntervalMs);
  uploadPruneTimer.unref();

  app.addHook('onClose', async () => {
    clearInterval(uploadPruneTimer);
    await uploadPrunePromise;
    await providerQueue.close();
    await importQueue.close();
    await pool.end();
  });

  await registerMetricsRoute(app, metrics, [
    { label: 'import', queue: importQueue },
    { label: 'provider', queue: providerQueue },
  ]);

  await registerHealthRoutes(app, pool, {
    queue: importQueue,
    checkObjectStorage: () => ensureBucket(objectStorage, config.s3.bucket),
    checkWorker: () => metrics.assertWorkerHeartbeatFresh(),
  });
  await registerUploadRoutes(app, pool, config, importQueue);
  await registerBookRoutes(app, pool, config);
  await registerAIRoutes(app, pool, config, providerQueue);
  await registerSyncRoutes(app, pool, config);
  await registerBackupRoutes(app, pool, config);
  await registerWebNovelMetadataCollectorGateway(app, config);

  return app;
}
