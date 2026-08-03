import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { mapChapterRows, mapManifestResponse, mapPageRows, mapParagraphSearchRows } from './row-mappers.js';

export async function registerBookContentRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/manifest', async (request, reply) => {
    const book = await pool.query(
      `
        select b.id, b.active_content_revision_id, b.format, b.title, b.author, b.series_title, b.series_index, b.tags,
               b.description, b.language, b.cover_asset_id, b.cover_fit, b.cover_position_x, b.cover_position_y,
               b.source_file_name, b.source_encoding,
               b.normalized_text_hash, b.total_chapters, b.total_characters, b.total_paragraphs, b.cover_seed,
               b.analysis_status, b.favorite, b.metadata_revision, b.created_at, b.updated_at,
               o.id as source_asset_id, o.raw_text_hash as source_content_hash,
               o.content_type as source_content_type, o.size_bytes as source_byte_length,
               ca.content_hash as cover_content_hash
        from library_books b
        left join book_objects o on o.id = b.object_id
        left join book_assets ca on ca.id = b.cover_asset_id
        where b.id = $1 and b.user_id = $2 and b.deleted_at is null
      `,
      [request.params.bookId, config.defaultUserId],
    );
    if (!book.rows[0]) return reply.code(404).send({ error: 'book not found' });

    const position = await pool.query('select * from reading_positions where book_id = $1 and user_id = $2', [
      request.params.bookId,
      config.defaultUserId,
    ]);

    return mapManifestResponse(book.rows, position.rows);
  });

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/chapters', async (request, reply) => {
    const exists = await pool.query(
      'select id from library_books where id = $1 and user_id = $2 and deleted_at is null',
      [request.params.bookId, config.defaultUserId],
    );
    if (!exists.rows[0]) return reply.code(404).send({ error: 'book not found' });

    const result = await pool.query(
      `
        select id, book_id, chapter_index, title, text_hash, raw_start_offset, raw_end_offset,
               character_count, paragraph_count, created_at, updated_at
        from chapters
        where book_id = $1
        order by chapter_index asc
      `,
      [request.params.bookId],
    );
    return { chapters: mapChapterRows(result.rows) };
  });

  app.get<{ Params: { chapterId: string } }>('/api/chapters/:chapterId', async (request, reply) => {
    const result = await pool.query(
      `
        select c.id, c.book_id, c.chapter_index, c.title, c.text_hash, c.raw_start_offset,
               c.raw_end_offset, c.character_count, c.paragraph_count, c.created_at, c.updated_at
        from chapters c
        join library_books b on b.id = c.book_id
        where c.id = $1 and b.user_id = $2 and b.deleted_at is null
      `,
      [request.params.chapterId, config.defaultUserId],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'chapter not found' });
    return { chapter: mapChapterRows(result.rows)[0] };
  });

  app.get<{ Params: { chapterId: string }; Querystring: { from?: string; count?: string } }>(
    '/api/chapters/:chapterId/pages',
    async (request, reply) => {
      const from = Math.max(0, Number.parseInt(request.query.from ?? '0', 10) || 0);
      const count = Math.min(20, Math.max(1, Number.parseInt(request.query.count ?? '5', 10) || 5));
      const result = await pool.query(
        `
          select pp.id, pp.book_id, pp.chapter_id, pp.page_index, pp.start_paragraph_index,
                 pp.end_paragraph_index, pp.paragraphs, pp.text_hash
          from paragraph_pages pp
          join library_books b on b.id = pp.book_id
          where pp.chapter_id = $1 and b.user_id = $2 and b.deleted_at is null and pp.page_index >= $3
          order by pp.page_index asc
          limit $4
        `,
        [request.params.chapterId, config.defaultUserId, from, count],
      );
      if (!result.rows.length) {
        const chapter = await pool.query(
          `
            select c.id
            from chapters c
            join library_books b on b.id = c.book_id
            where c.id = $1 and b.user_id = $2 and b.deleted_at is null
          `,
          [request.params.chapterId, config.defaultUserId],
        );
        if (!chapter.rows[0]) return reply.code(404).send({ error: 'chapter not found' });
      }
      return { pages: mapPageRows(result.rows) };
    },
  );

  app.get<{ Params: { paragraphId: string } }>('/api/paragraphs/:paragraphId', async (request, reply) => {
    const result = await pool.query(
      `
          select ps.paragraph
          from paragraph_search ps
          join library_books b on b.id = ps.book_id
          where b.user_id = $1 and b.deleted_at is null and ps.paragraph_id = $2
          limit 1
        `,
      [config.defaultUserId, request.params.paragraphId],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'paragraph not found' });
    return { paragraph: mapParagraphSearchRows(result.rows)[0] };
  });
}
