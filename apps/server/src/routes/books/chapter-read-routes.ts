import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { ServerConfig } from '../../config.js';

export function registerChapterReadRoutes(app: FastifyInstance, pool: pg.Pool, config: ServerConfig) {
  app.patch<{
    Params: { bookId: string; chapterId: string };
    Body: { title?: unknown; expectedContentRevisionId?: unknown };
  }>('/api/books/:bookId/chapters/:chapterId', async (request, reply) => {
    const body = request.body;
    if (
      !body ||
      typeof body.title !== 'string' ||
      !body.title.trim() ||
      body.title.trim().length > 200 ||
      (body.expectedContentRevisionId !== undefined && typeof body.expectedContentRevisionId !== 'string')
    )
      return reply.code(400).send({ error: '제목을 1~200자로 입력해 주세요.' });
    const result = await pool.query(
      `
        with book_write_lock as (select pg_advisory_xact_lock(hashtextextended($1, 7319)))
        update chapters c set title = $4, updated_at = now()
        from library_books b, book_write_lock
        where b.id = $1 and b.user_id = $2 and b.deleted_at is null
          and b.active_content_revision_id is not distinct from $5::text
          and c.book_id = b.id and c.id = $3 returning c.id`,
      [
        request.params.bookId,
        config.defaultUserId,
        request.params.chapterId,
        body.title.trim(),
        body.expectedContentRevisionId ?? null,
      ],
    );
    if (!result.rows.length) return reply.code(409).send({ error: '회차가 변경되었습니다. 다시 열어 주세요.' });
    return { ok: true };
  });
  app.post<{
    Params: { bookId: string };
    Body: { chapterId?: unknown; previous?: unknown; expectedContentRevisionId?: unknown };
  }>('/api/books/:bookId/chapters/read', async (request, reply) => {
    const body = request.body;
    if (
      !body ||
      typeof body.chapterId !== 'string' ||
      !body.chapterId ||
      typeof body.previous !== 'boolean' ||
      (body.expectedContentRevisionId !== undefined && typeof body.expectedContentRevisionId !== 'string')
    )
      return reply.code(400).send({ error: 'invalid chapter read request' });
    const result = await pool.query(
      `
        with book_write_lock as (select pg_advisory_xact_lock(hashtextextended($1, 7319))),
        target as (
          select c.id, c.book_id, c.chapter_index
          from book_write_lock
          join library_books b on b.id = $1 and b.user_id = $2 and b.deleted_at is null
          join chapters c on c.book_id = b.id and c.id = $3
          where b.active_content_revision_id is not distinct from $5::text
        ), marked as (
          insert into fixed_document_section_read_states (book_id, user_id, document_section_id, last_read_at)
          select distinct c.book_id, $2, coalesce(c.document_section_id, c.id), now()
          from chapters c join target t on t.book_id = c.book_id
          where case when $4::boolean then c.chapter_index < t.chapter_index else c.id = t.id end
          on conflict (book_id, user_id, document_section_id) do update set last_read_at = excluded.last_read_at
          returning document_section_id
        ) select exists(select 1 from target) as found, (select count(*) from marked) as marked`,
      [
        request.params.bookId,
        config.defaultUserId,
        body.chapterId,
        body.previous,
        body.expectedContentRevisionId ?? null,
      ],
    );
    if (!result.rows[0]?.found) return reply.code(409).send({ error: '회차가 변경되었습니다. 다시 열어 주세요.' });
    return { ok: true };
  });
}
