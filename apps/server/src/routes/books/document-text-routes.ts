import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { DocumentTextBlock, DocumentTextRevision } from '@noveldesk/contracts';
import type { ServerConfig } from '../../config.js';
import { withTransaction } from '../ai/sync-event-repository.js';

const MAX_BLOCKS_PER_PAGE = 512;
const MAX_BLOCK_TEXT = 64 * 1024;
const MAX_PAGE_TEXT = 2 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function textQuads(value: unknown): DocumentTextBlock['quads'] | undefined {
  if (!Array.isArray(value) || value.length > 4_096) return undefined;
  const quads: DocumentTextBlock['quads'] = [];
  for (const candidate of value) {
    const quad = record(candidate);
    const x = finiteNumber(quad?.x);
    const y = finiteNumber(quad?.y);
    const width = finiteNumber(quad?.width);
    const height = finiteNumber(quad?.height);
    if (
      x === undefined ||
      y === undefined ||
      width === undefined ||
      height === undefined ||
      x < 0 ||
      y < 0 ||
      width < 0 ||
      height < 0 ||
      x > 1 ||
      y > 1 ||
      width > 1 ||
      height > 1 ||
      x + width > 1.000_001 ||
      y + height > 1.000_001
    ) {
      return undefined;
    }
    quads.push({ x, y, width, height });
  }
  return quads;
}

export function parseDocumentTextPage(
  bookId: string,
  pageIndex: number,
  value: unknown,
): { revision: DocumentTextRevision; blocks: DocumentTextBlock[] } | undefined {
  const body = record(value);
  const revision = record(body?.revision);
  const rawBlocks = Array.isArray(body?.blocks) ? body.blocks : undefined;
  if (!revision || !rawBlocks || rawBlocks.length > MAX_BLOCKS_PER_PAGE) return undefined;
  const qualityScore = finiteNumber(revision.qualityScore);
  if (
    typeof revision.id !== 'string' ||
    !revision.id ||
    revision.bookId !== bookId ||
    revision.pageIndex !== pageIndex ||
    typeof revision.pageHash !== 'string' ||
    !revision.pageHash ||
    (revision.source !== 'pdf_native' && revision.source !== 'ocr') ||
    typeof revision.engine !== 'string' ||
    typeof revision.engineVersion !== 'string' ||
    revision.status !== 'ready' ||
    typeof revision.createdAt !== 'string' ||
    typeof revision.updatedAt !== 'string'
  ) {
    return undefined;
  }
  if (qualityScore !== undefined && (qualityScore < 0 || qualityScore > 1)) return undefined;
  const ids = new Set<string>();
  let textBytes = 0;
  const blocks: DocumentTextBlock[] = [];
  for (const candidate of rawBlocks) {
    const block = record(candidate);
    const quads = textQuads(block?.quads);
    if (
      !block ||
      typeof block.id !== 'string' ||
      !block.id ||
      ids.has(block.id) ||
      block.revisionId !== revision.id ||
      block.bookId !== bookId ||
      block.pageIndex !== pageIndex ||
      !Number.isInteger(block.order) ||
      Number(block.order) < 0 ||
      !['heading', 'paragraph', 'list_item', 'caption', 'footnote', 'unknown'].includes(String(block.role)) ||
      typeof block.text !== 'string' ||
      block.text.length === 0 ||
      block.text.length > MAX_BLOCK_TEXT ||
      !quads ||
      !['ltr', 'rtl', 'ttb'].includes(String(block.direction))
    ) {
      return undefined;
    }
    ids.add(block.id);
    textBytes += Buffer.byteLength(block.text, 'utf8');
    if (textBytes > MAX_PAGE_TEXT) return undefined;
    blocks.push({
      id: block.id,
      revisionId: revision.id,
      bookId,
      pageIndex,
      order: Number(block.order),
      role: block.role as DocumentTextBlock['role'],
      text: block.text,
      normalizedText: block.text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim(),
      quads,
      direction: block.direction as DocumentTextBlock['direction'],
    });
  }
  return {
    revision: {
      id: revision.id,
      bookId,
      pageIndex,
      pageHash: revision.pageHash,
      source: revision.source,
      engine: revision.engine,
      engineVersion: revision.engineVersion,
      language: typeof revision.language === 'string' ? revision.language : undefined,
      status: 'ready',
      qualityScore,
      createdAt: revision.createdAt,
      updatedAt: revision.updatedAt,
    },
    blocks: blocks.sort((left, right) => left.order - right.order),
  };
}

export async function registerDocumentTextRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  app.put<{ Params: { bookId: string; pageIndex: string }; Body: unknown }>(
    '/api/books/:bookId/document-text/pages/:pageIndex',
    async (request, reply) => {
      const pageIndex = Number(request.params.pageIndex);
      if (!Number.isInteger(pageIndex) || pageIndex < 0) return reply.code(400).send({ error: 'invalid page index' });
      const parsed = parseDocumentTextPage(request.params.bookId, pageIndex, request.body);
      if (!parsed) return reply.code(400).send({ error: 'invalid document text page' });
      const saved = await withTransaction(pool, async (db) => {
        const access = await db.query<{ exists: boolean }>(
          `select exists(select 1 from library_books where id = $1 and user_id = $2 and deleted_at is null) as exists`,
          [request.params.bookId, config.defaultUserId],
        );
        if (!access.rows[0]?.exists) return false;
        const conflict = await db.query<{ exists: boolean }>(
          `select exists(
             select 1 from document_text_revisions
             where id = $1 and (book_id <> $2 or page_index <> $3)
           ) as exists`,
          [parsed.revision.id, request.params.bookId, pageIndex],
        );
        if (conflict.rows[0]?.exists) return false;
        await db.query(
          `update document_text_revisions set status = 'stale', updated_at = now()
           where book_id = $1 and page_index = $2 and id <> $3 and status = 'ready'`,
          [request.params.bookId, pageIndex, parsed.revision.id],
        );
        const revisionSaved = await db.query(
          `insert into document_text_revisions
             (id, book_id, page_index, page_hash, source, engine, engine_version, language, status, quality_score, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'ready',$9,$10,$11)
           on conflict (id) do update set
             page_hash = excluded.page_hash, source = excluded.source, engine = excluded.engine,
             engine_version = excluded.engine_version, language = excluded.language, status = 'ready',
             quality_score = excluded.quality_score, updated_at = excluded.updated_at
           where document_text_revisions.book_id = excluded.book_id
             and document_text_revisions.page_index = excluded.page_index`,
          [
            parsed.revision.id,
            request.params.bookId,
            pageIndex,
            parsed.revision.pageHash,
            parsed.revision.source,
            parsed.revision.engine,
            parsed.revision.engineVersion,
            parsed.revision.language ?? null,
            parsed.revision.qualityScore ?? null,
            parsed.revision.createdAt,
            parsed.revision.updatedAt,
          ],
        );
        if ((revisionSaved.rowCount ?? 0) === 0) return false;
        await db.query('delete from document_text_blocks where revision_id = $1 and book_id = $2', [
          parsed.revision.id,
          request.params.bookId,
        ]);
        for (const block of parsed.blocks) {
          await db.query(
            `insert into document_text_blocks
               (id, revision_id, book_id, page_index, block_order, role, text, normalized_text, quads, direction)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              block.id,
              block.revisionId,
              block.bookId,
              block.pageIndex,
              block.order,
              block.role,
              block.text,
              block.normalizedText,
              JSON.stringify(block.quads),
              block.direction,
            ],
          );
        }
        return true;
      });
      if (!saved) return reply.code(404).send({ error: 'book not found' });
      return { revisionId: parsed.revision.id, blockCount: parsed.blocks.length };
    },
  );
}
