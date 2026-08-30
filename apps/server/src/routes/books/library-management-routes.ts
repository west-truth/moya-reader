import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import type {
  BatchLibraryCommand,
  BatchLibraryTarget,
} from '../../../../../src/repositories/library-catalog-repository.js';
import {
  applyHostedLibraryBatch,
  createHostedShelf,
  deleteHostedShelf,
  listHostedShelves,
  setHostedShelfMembership,
  updateHostedShelf,
} from '../../services/hosted-library-management-service.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function batchCommand(value: unknown): BatchLibraryCommand | undefined {
  const row = record(value);
  if (!row || typeof row.kind !== 'string') return undefined;
  if ((row.kind === 'add_to_shelf' || row.kind === 'remove_from_shelf') && typeof row.shelfId === 'string') {
    return { kind: row.kind, shelfId: row.shelfId };
  }
  if ((row.kind === 'add_tag' || row.kind === 'remove_tag') && typeof row.tag === 'string') {
    return { kind: row.kind, tag: row.tag };
  }
  if (row.kind === 'set_favorite' && typeof row.favorite === 'boolean') {
    return { kind: row.kind, favorite: row.favorite };
  }
  if (row.kind === 'move_to_trash' || row.kind === 'restore_from_trash') return { kind: row.kind };
  return undefined;
}

function batchTargets(value: unknown): BatchLibraryTarget[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) return undefined;
  const targets: BatchLibraryTarget[] = [];
  for (const item of value) {
    const row = record(item);
    if (!row || typeof row.bookId !== 'string') return undefined;
    if (
      row.expectedRevision !== undefined &&
      (!Number.isSafeInteger(row.expectedRevision) || Number(row.expectedRevision) < 0)
    ) {
      return undefined;
    }
    if (
      row.expectedContentRevisionId !== undefined &&
      (typeof row.expectedContentRevisionId !== 'string' || !row.expectedContentRevisionId.trim())
    ) {
      return undefined;
    }
    targets.push({
      bookId: row.bookId,
      expectedRevision: row.expectedRevision as number | undefined,
      expectedContentRevisionId: row.expectedContentRevisionId as string | undefined,
    });
  }
  return targets;
}

export async function registerLibraryManagementRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  app.get('/api/shelves', async () => listHostedShelves(pool, config));

  app.post<{ Body: { name?: unknown; color?: unknown } }>('/api/shelves', async (request, reply) => {
    if (
      typeof request.body?.name !== 'string' ||
      (request.body.color !== undefined && typeof request.body.color !== 'string')
    ) {
      return reply.code(400).send({ error: 'invalid shelf' });
    }
    try {
      return { shelf: await createHostedShelf(pool, config, { name: request.body.name, color: request.body.color }) };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'shelf create failed' });
    }
  });

  app.patch<{
    Params: { shelfId: string };
    Body: { name?: unknown; color?: unknown; sortOrder?: unknown; expectedRevision?: unknown };
  }>('/api/shelves/:shelfId', async (request, reply) => {
    const { name, color, sortOrder, expectedRevision } = request.body ?? {};
    if (
      (name !== undefined && typeof name !== 'string') ||
      (color !== undefined && color !== null && typeof color !== 'string') ||
      (sortOrder !== undefined && !Number.isSafeInteger(sortOrder)) ||
      (expectedRevision !== undefined && !Number.isSafeInteger(expectedRevision))
    ) {
      return reply.code(400).send({ error: 'invalid shelf patch' });
    }
    try {
      return {
        shelf: await updateHostedShelf(pool, config, request.params.shelfId, {
          name: name as string | undefined,
          color: color as string | null | undefined,
          sortOrder: sortOrder as number | undefined,
          expectedRevision: expectedRevision as number | undefined,
        }),
      };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'shelf update failed' });
    }
  });

  app.delete<{ Params: { shelfId: string }; Body: { expectedRevision?: unknown } }>(
    '/api/shelves/:shelfId',
    async (request, reply) => {
      const expected = request.body?.expectedRevision;
      if (expected !== undefined && !Number.isSafeInteger(expected)) {
        return reply.code(400).send({ error: 'invalid shelf revision' });
      }
      try {
        return { shelf: await deleteHostedShelf(pool, config, request.params.shelfId, expected as number | undefined) };
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : 'shelf delete failed' });
      }
    },
  );

  for (const method of ['PUT', 'DELETE'] as const) {
    app.route<{ Params: { shelfId: string; bookId: string } }>({
      method,
      url: '/api/shelves/:shelfId/books/:bookId',
      handler: async (request, reply) => {
        try {
          await setHostedShelfMembership(pool, config, request.params.shelfId, request.params.bookId, method === 'PUT');
          return { ok: true };
        } catch (error) {
          return reply.code(409).send({ error: error instanceof Error ? error.message : 'membership update failed' });
        }
      },
    });
  }

  app.post<{ Body: unknown }>('/api/library/batch', async (request, reply) => {
    const body = record(request.body);
    const command = batchCommand(body?.command);
    const targets = batchTargets(body?.targets);
    const idempotencyKey = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
    if (!command || !targets || !idempotencyKey || idempotencyKey.length > 200) {
      return reply.code(400).send({ error: 'invalid library batch' });
    }
    return { receipt: await applyHostedLibraryBatch(pool, config, command, targets, idempotencyKey) };
  });
}
