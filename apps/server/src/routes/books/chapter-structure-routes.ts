import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ChapterStructureCommand } from '@noveldesk/text-core/chapter-structure';
import type { ServerConfig } from '../../config.js';
import {
  applyHostedChapterStructure,
  getHostedChapterStructureEditorState,
  listHostedChapterStructureReview,
  previewHostedChapterStructure,
  rollbackHostedChapterStructure,
} from '../../services/hosted-chapter-structure-service.js';

function command(value: unknown): value is ChapterStructureCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.kind === 'rename') return typeof row.chapterId === 'string' && typeof row.title === 'string';
  if (row.kind === 'split') {
    return (
      typeof row.chapterId === 'string' &&
      Number.isSafeInteger(row.sourceOffset) &&
      (row.title === undefined || typeof row.title === 'string')
    );
  }
  if (row.kind === 'merge_next') {
    return (
      typeof row.chapterId === 'string' &&
      ['first', 'second', 'custom'].includes(String(row.titlePolicy)) &&
      (row.title === undefined || typeof row.title === 'string')
    );
  }
  if (row.kind === 'reparse_range') {
    return (
      Number.isSafeInteger(row.startOffset) &&
      (row.endOffset === undefined || Number.isSafeInteger(row.endOffset)) &&
      ['auto', 'mixed', 'single'].includes(String(row.splitMode))
    );
  }
  return false;
}

function commands(body: unknown): ChapterStructureCommand[] | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const rows = (body as Record<string, unknown>).commands;
  return Array.isArray(rows) && rows.length > 0 && rows.length <= 100 && rows.every(command) ? rows : undefined;
}

export async function registerChapterStructureRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/chapter-structure', async (request, reply) => {
    try {
      return { editor: await getHostedChapterStructureEditorState(pool, config, request.params.bookId) };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'chapter structure unavailable' });
    }
  });

  app.post<{ Params: { bookId: string }; Body: unknown }>(
    '/api/books/:bookId/chapter-structure/preview',
    async (request, reply) => {
      const parsed = commands(request.body);
      if (!parsed) return reply.code(400).send({ error: 'invalid chapter structure commands' });
      try {
        return { preview: await previewHostedChapterStructure(pool, config, request.params.bookId, parsed) };
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : 'preview failed' });
      }
    },
  );

  app.post<{ Params: { draftId: string } }>('/api/chapter-structure/drafts/:draftId/apply', async (request, reply) => {
    try {
      return { receipt: await applyHostedChapterStructure(pool, config, request.params.draftId) };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'apply failed' });
    }
  });

  app.post<{ Params: { receiptId: string } }>(
    '/api/chapter-structure/receipts/:receiptId/rollback',
    async (request, reply) => {
      try {
        return { receipt: await rollbackHostedChapterStructure(pool, config, request.params.receiptId) };
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : 'rollback failed' });
      }
    },
  );

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/chapter-structure/review', async (request) => ({
    items: await listHostedChapterStructureReview(pool, config, request.params.bookId),
  }));
}
