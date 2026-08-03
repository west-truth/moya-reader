import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../config.js';
import { MAX_HOSTED_BACKUP_UNCOMPRESSED_BYTES } from '../services/hosted-backup-archive.js';
import {
  exportHostedBackup,
  inspectHostedBackup,
  restoreHostedBackup,
  type HostedBackupConflictResolution,
  type HostedBackupRestoreOptions,
} from '../services/hosted-backup-service.js';

const resolutions = new Set<HostedBackupConflictResolution>(['skip', 'replace', 'copy']);

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function restoreOptions(headers: Record<string, string | string[] | undefined>): HostedBackupRestoreOptions {
  const defaultValue = headerValue(headers['x-backup-default-resolution']) ?? 'skip';
  if (!resolutions.has(defaultValue as HostedBackupConflictResolution)) {
    throw new Error('Invalid default backup conflict resolution');
  }
  const rawOverrides = headerValue(headers['x-backup-conflict-resolutions']);
  if (!rawOverrides) return { defaultConflictResolution: defaultValue as HostedBackupConflictResolution };
  const parsed = JSON.parse(rawOverrides) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid backup conflict resolution map');
  }
  const conflictResolutions: Record<string, HostedBackupConflictResolution> = {};
  for (const [bookId, value] of Object.entries(parsed)) {
    if (!bookId || !resolutions.has(value as HostedBackupConflictResolution)) {
      throw new Error('Invalid backup conflict resolution entry');
    }
    conflictResolutions[bookId] = value as HostedBackupConflictResolution;
  }
  return {
    defaultConflictResolution: defaultValue as HostedBackupConflictResolution,
    conflictResolutions,
  };
}

function archiveBody(body: unknown): Uint8Array {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return body;
  throw new Error('Backup archive body is missing');
}

async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function registerBackupRoutes(app: FastifyInstance, pool: pg.Pool, config: ServerConfig): Promise<void> {
  app.get('/api/backups/export', async (_request, reply) => {
    const result = await exportHostedBackup(pool, config);
    void result.completion.catch((error) => app.log.error({ error }, 'hosted backup stream failed'));
    const fileName = `moya-backup-${new Date().toISOString().slice(0, 10)}.zip`;
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${fileName}"`)
      .send(Readable.from(streamChunks(result.readable)));
  });

  app.post('/api/backups/inspect', { bodyLimit: MAX_HOSTED_BACKUP_UNCOMPRESSED_BYTES }, async (request, reply) => {
    try {
      return await inspectHostedBackup(pool, config, archiveBody(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid backup archive' });
    }
  });

  app.post('/api/backups/restore', { bodyLimit: MAX_HOSTED_BACKUP_UNCOMPRESSED_BYTES }, async (request, reply) => {
    try {
      return await restoreHostedBackup(pool, config, archiveBody(request.body), restoreOptions(request.headers));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Backup restore failed' });
    }
  });
}
