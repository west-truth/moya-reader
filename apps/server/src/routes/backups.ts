import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { BackupStaging } from '../services/backup-staging.js';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../config.js';

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

export async function registerBackupRoutes(app: FastifyInstance, pool: pg.Pool, config: ServerConfig): Promise<void> {
  const staging = new BackupStaging(path.join(config.dataDir, 'backup-staging'), config.defaultUserId);
  const tickets = new Map<string, number>();
  app.addHook('onClose', async () => {
    tickets.clear();
    await staging.close();
  });
  app.post('/api/backups/download', async (_request, reply) => {
    const now = Date.now();
    for (const [id, expires] of tickets) if (expires <= now) tickets.delete(id);
    if (tickets.size >= 8) return reply.code(429).send({ error: '잠시 후 다시 시도해 주세요.' });
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(ticket, now + 60_000);
    return reply.header('Cache-Control', 'no-store').send({ ticket });
  });
  let exporting = false;
  let restoring = false;
  async function sendExport(reply: import('fastify').FastifyReply, bufferedClient = false) {
    if (exporting) return reply.code(409).send({ error: '백업 다운로드가 이미 진행 중입니다.' });
    exporting = true;
    const abort = new AbortController();
    reply.raw.once('close', () => abort.abort());
    try {
      const result = await exportHostedBackup(pool, config, abort.signal, bufferedClient);
      void result.completion
        .catch((error) => app.log.error({ error }, 'hosted backup stream failed'))
        .finally(() => {
          exporting = false;
        });
      return reply
        .header('Content-Type', 'application/zip')
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .header('X-Accel-Buffering', 'no')
        .header(
          'Content-Disposition',
          `attachment; filename="moya-backup-${new Date().toISOString().slice(0, 10)}.zip"`,
        )
        .send(Readable.fromWeb(result.readable as never));
    } catch (error) {
      exporting = false;
      throw error;
    }
  }
  app.get('/api/backups/export', async (_request, reply) => sendExport(reply, true));
  app.get<{ Params: { ticket: string } }>('/api/backups/download/:ticket', async (request, reply) => {
    const expires = tickets.get(request.params.ticket);
    tickets.delete(request.params.ticket);
    if (!expires || expires <= Date.now())
      return reply.code(410).send({ error: '다운로드 주소가 만료되었습니다. 다시 눌러 주세요.' });
    return sendExport(reply);
  });
  app.delete<{ Params: { id: string } }>('/api/backups/staged/:id', async (request) => {
    await staging.discard(request.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/backups/staged/:id/restore', async (request, reply) => {
    if (restoring) return reply.code(409).send({ error: '다른 백업을 복원 중입니다. 완료 후 다시 시도해 주세요.' });
    // Validate choices before claiming the inspected archive.
    let options: HostedBackupRestoreOptions;
    try {
      options = restoreOptions(request.headers);
    } catch {
      return reply.code(400).send({ error: '복원 선택값을 확인해 주세요.' });
    }
    let stage: ReturnType<BackupStaging['take']>;
    try {
      stage = staging.take(request.params.id);
    } catch (error) {
      return reply.code(410).send({ error: error instanceof Error ? error.message : 'Backup expired' });
    }
    restoring = true;
    try {
      return await restoreHostedBackup(pool, config, stage.parsed, options);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Backup restore failed' });
    } finally {
      restoring = false;
      await stage.dispose();
    }
  });

  // Encapsulate streaming parsers so unrelated upload routes keep their existing bounded buffers.
  await app.register(async (scope) => {
    for (const type of ['application/zip', 'application/octet-stream']) {
      if (scope.hasContentTypeParser(type)) scope.removeContentTypeParser(type);
      scope.addContentTypeParser(type, (_request, payload, done) => done(null, payload));
    }
    for (const mode of ['inspect', 'restore'] as const) {
      scope.post(`/api/backups/${mode}`, async (request, reply) => {
        if (!(request.body instanceof Readable))
          return reply.code(400).send({ error: 'Backup archive body is missing' });
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(new Error('백업 업로드 시간이 초과되었습니다.')), 60 * 60_000);
        timeout.unref();
        const disconnected = () => {
          if (!reply.raw.writableFinished) abort.abort();
        };
        reply.raw.once('close', disconnected);
        let stagedId: string | undefined;
        try {
          const options = mode === 'restore' ? restoreOptions(request.headers) : undefined;
          const received = await staging.receive(
            request.body,
            request.headers['content-length'] === undefined ? undefined : Number(request.headers['content-length']),
            abort.signal,
          );
          stagedId = received.id;
          if (mode === 'inspect') {
            const inspection = await inspectHostedBackup(
              pool,
              config,
              received.stage.parsed,
              received.stage.byteLength,
            );
            abort.signal.throwIfAborted();
            return reply.header('Cache-Control', 'no-store').send({
              ...inspection,
              warnings:
                received.stage.source === 'local'
                  ? [
                      ...inspection.warnings,
                      '기존 로컬 백업을 서버 저장 형식으로 검증했습니다. 원본 ZIP은 그대로 보존하세요.',
                    ]
                  : inspection.warnings,
              stagedId,
            });
          }
          if (restoring) throw new Error('다른 백업을 복원 중입니다. 완료 후 다시 시도해 주세요.');
          const stage = staging.take(stagedId);
          restoring = true;
          try {
            return await restoreHostedBackup(pool, config, stage.parsed, options!);
          } finally {
            restoring = false;
            await stage.dispose();
          }
        } catch (error) {
          if (stagedId) await staging.discard(stagedId);
          return reply.code(400).send({ error: error instanceof Error ? error.message : 'Backup archive failed' });
        } finally {
          clearTimeout(timeout);
          reply.raw.removeListener('close', disconnected);
        }
      });
    }
  });
}
