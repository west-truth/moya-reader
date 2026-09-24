import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { DocumentAnnotation } from '@noveldesk/contracts';
import type { ServerConfig } from '../../config.js';
import { parseDocumentAnnotationPayload } from '../sync/event-contracts.js';
import { createServerRevision } from './sync-event-repository.js';
import { insertServerSyncEvent, withTransaction } from '../ai/sync-event-repository.js';
import { lockBookResource } from '../resource-revision.js';
import { documentPageHash } from './document-page-identity.js';
import { validDocumentTextAnchor } from './document-text-anchor.js';
import { activeBookContentRevisionId, readerEntityRevision, readerEntityValue } from './reader-entity-revisions.js';
import { expectedResourceRevision } from '../resource-revision.js';

function mapRow(row: Record<string, unknown>): DocumentAnnotation {
  return {
    id: String(row.id),
    bookId: String(row.book_id),
    pageIndex: Number(row.page_index),
    type: row.annotation_type as DocumentAnnotation['type'],
    anchor: row.anchor as DocumentAnnotation['anchor'],
    ...(row.quote == null ? {} : { quote: String(row.quote) }),
    ...(row.body == null ? {} : { body: String(row.body) }),
    ...(row.color == null ? {} : { color: String(row.color) }),
    ...(row.text_anchor_remap == null
      ? {}
      : { textAnchorRemap: row.text_anchor_remap as DocumentAnnotation['textAnchorRemap'] }),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export async function registerDocumentAnnotationRoutes(app: FastifyInstance, pool: pg.Pool, config: ServerConfig) {
  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/document-annotations', async (request, reply) => {
    const book = await pool.query('select 1 from library_books where id = $1 and user_id = $2 and deleted_at is null', [
      request.params.bookId,
      config.defaultUserId,
    ]);
    if (!book.rows[0]) return reply.code(404).send({ error: 'book not found' });
    const result = await pool.query(
      `select id, book_id, page_index, annotation_type, anchor, quote, body, color,
              text_anchor_remap, created_at, updated_at
       from document_annotations
       where book_id = $1 and user_id = $2 and deleted_at is null
       order by updated_at desc`,
      [request.params.bookId, config.defaultUserId],
    );
    return { annotations: result.rows.map(mapRow) };
  });

  app.put<{ Params: { bookId: string; annotationId: string }; Body: unknown }>(
    '/api/books/:bookId/document-annotations/:annotationId',
    async (request, reply) => {
      const body = request.body;
      const candidate =
        body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
      const expectedRevision = expectedResourceRevision(candidate);
      const now = new Date().toISOString();
      const parsed = parseDocumentAnnotationPayload({
        payload: { annotation: candidate },
        novelId: request.params.bookId,
        entityId: request.params.annotationId,
        createdAt: now,
      });
      if (!parsed.ok || candidate.id !== request.params.annotationId || candidate.bookId !== request.params.bookId) {
        return reply
          .code(400)
          .send({ error: parsed.ok ? 'annotation identity does not match the book' : parsed.message });
      }
      const createdAt =
        typeof candidate.createdAt === 'string' && Number.isFinite(Date.parse(candidate.createdAt))
          ? candidate.createdAt
          : undefined;
      const updatedAt =
        typeof candidate.updatedAt === 'string' && Number.isFinite(Date.parse(candidate.updatedAt))
          ? candidate.updatedAt
          : undefined;
      if (
        !createdAt ||
        !updatedAt ||
        candidate.deletedAt ||
        (candidate.quote != null && typeof candidate.quote !== 'string') ||
        (candidate.body != null && typeof candidate.body !== 'string') ||
        (candidate.color != null && typeof candidate.color !== 'string') ||
        (candidate.textAnchorRemap != null &&
          (typeof candidate.textAnchorRemap !== 'object' || Array.isArray(candidate.textAnchorRemap)))
      ) {
        return reply.code(400).send({ error: 'invalid document annotation fields' });
      }
      const result = await withTransaction(pool, async (db) => {
        if (!(await lockBookResource(db, config.defaultUserId, parsed.bookId))) return 'missing_book';
        const baseEntityRevision = await readerEntityRevision(
          db,
          config.defaultUserId,
          'document_annotation',
          parsed.id,
        );
        if (expectedRevision && expectedRevision !== baseEntityRevision) return 'conflict';
        const pageHash = await documentPageHash(db, parsed.bookId, parsed.pageIndex, config.defaultUserId);
        if (!pageHash) return 'missing_page';
        const anchor = candidate.anchor as Record<string, unknown>;
        if (typeof anchor.pageHash === 'string' && anchor.pageHash !== pageHash) return 'stale_page';
        if (!(await validDocumentTextAnchor(db, parsed.bookId, parsed.pageIndex, pageHash, anchor)))
          return 'stale_text';
        const saved = await db.query(
          `insert into document_annotations
             (id, book_id, user_id, page_index, annotation_type, anchor, quote, body, color,
              text_anchor_remap, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,$12)
           on conflict (id) do update set
             page_index = excluded.page_index, annotation_type = excluded.annotation_type,
             anchor = excluded.anchor, quote = excluded.quote, body = excluded.body,
             color = excluded.color, text_anchor_remap = excluded.text_anchor_remap,
             updated_at = excluded.updated_at, deleted_at = null
           where document_annotations.book_id = excluded.book_id
             and document_annotations.user_id = excluded.user_id
             and (document_annotations.updated_at <= excluded.updated_at or $13::boolean)
           returning id`,
          [
            parsed.id,
            parsed.bookId,
            config.defaultUserId,
            parsed.pageIndex,
            String(candidate.type),
            JSON.stringify(candidate.anchor),
            candidate.quote ?? null,
            candidate.body ?? null,
            candidate.color ?? null,
            candidate.textAnchorRemap ? JSON.stringify(candidate.textAnchorRemap) : null,
            createdAt,
            updatedAt,
            Boolean(expectedRevision),
          ],
        );
        if (!saved.rows[0]) return 'conflict';
        const payload = {
          annotation: await readerEntityValue(db, config.defaultUserId, 'document_annotation', parsed.id),
          baseEntityRevision,
          targetEntityRevision: await readerEntityRevision(db, config.defaultUserId, 'document_annotation', parsed.id),
          contentRevisionId: await activeBookContentRevisionId(db, config.defaultUserId, parsed.bookId),
        };
        await insertServerSyncEvent(db, config.defaultUserId, {
          seed: `document_annotation_updated:${parsed.id}:${updatedAt}:${randomUUID()}`,
          type: 'document_annotation_updated',
          bookId: parsed.bookId,
          entityId: parsed.id,
          payload,
          revision: createServerRevision({
            entityType: 'document_annotation',
            entityId: parsed.id,
            novelId: parsed.bookId,
            updatedAt,
            payload,
          }),
          createdAt: updatedAt,
        });
        return 'saved';
      });
      if (result === 'missing_book' || result === 'missing_page') return reply.code(404).send({ error: result });
      if (result !== 'saved') return reply.code(409).send({ error: result });
      return { ok: true };
    },
  );

  app.delete<{ Params: { bookId: string; annotationId: string }; Body: Record<string, unknown> }>(
    '/api/books/:bookId/document-annotations/:annotationId',
    async (request, reply) => {
      const deletedAt = new Date().toISOString();
      const expectedRevision = expectedResourceRevision(request.body);
      const result = await withTransaction(pool, async (db) => {
        if (!(await lockBookResource(db, config.defaultUserId, request.params.bookId))) return false;
        const baseEntityRevision = await readerEntityRevision(
          db,
          config.defaultUserId,
          'document_annotation',
          request.params.annotationId,
        );
        if (expectedRevision && expectedRevision !== baseEntityRevision) return 'conflict';
        const deleted = await db.query(
          `update document_annotations set deleted_at = $4, updated_at = $4
           where id = $1 and book_id = $2 and user_id = $3 and deleted_at is null returning id`,
          [request.params.annotationId, request.params.bookId, config.defaultUserId, deletedAt],
        );
        if (!deleted.rows[0]) return false;
        const payload = {
          id: request.params.annotationId,
          deletedAt,
          baseEntityRevision,
          targetEntityRevision: await readerEntityRevision(
            db,
            config.defaultUserId,
            'document_annotation',
            request.params.annotationId,
          ),
          contentRevisionId: await activeBookContentRevisionId(db, config.defaultUserId, request.params.bookId),
        };
        await insertServerSyncEvent(db, config.defaultUserId, {
          seed: `document_annotation_deleted:${request.params.annotationId}:${deletedAt}`,
          type: 'document_annotation_deleted',
          bookId: request.params.bookId,
          entityId: request.params.annotationId,
          payload,
          revision: createServerRevision({
            entityType: 'document_annotation',
            entityId: request.params.annotationId,
            novelId: request.params.bookId,
            deletedAt,
            payload,
          }),
          createdAt: deletedAt,
        });
        return true;
      });
      if (result === 'conflict') return reply.code(409).send({ error: 'resource revision conflict' });
      if (!result) return reply.code(404).send({ error: 'annotation not found' });
      return { ok: true };
    },
  );
}
