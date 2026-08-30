import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import {
  canonicalContentReadRevision,
  contentReadRevisionConflict,
  expectedContentReadRevision,
  sendContentReadRevisionConflict,
  withoutContentReadRevision,
  type ContentReadRevisionRow,
} from './content-read-revision.js';
import { mapChapterRows, mapManifestResponse, mapPageRows, mapParagraphSearchRows } from './row-mappers.js';

export async function registerBookContentRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  app.get<{ Params: { bookId: string }; Querystring: { contentRevisionId?: string } }>(
    '/api/books/:bookId/manifest',
    async (request, reply) => {
    const book = await pool.query(
      `
        select b.id, b.active_content_revision_id, b.format, b.title, b.author, b.series_title, b.series_index, b.tags,
               b.description, b.language, b.cover_asset_id, b.cover_fit, b.cover_position_x, b.cover_position_y,
               b.cover_removed_at,
               b.source_file_name, b.source_encoding,
               b.normalized_text_hash, b.total_chapters, b.total_characters, b.total_paragraphs,
               b.document_section_count, b.cover_seed,
               b.analysis_status, b.favorite, b.metadata_revision, b.created_at, b.updated_at,
               o.id as source_asset_id, o.raw_text_hash as source_content_hash,
               o.content_type as source_content_type, o.size_bytes as source_byte_length,
               ca.content_hash as cover_content_hash,
               rp.chapter_id as last_read_chapter_id, rp.paragraph_id as last_read_paragraph_id,
               rc.chapter_index as last_read_chapter_index, rp.scroll_top as last_read_offset,
               case
                 when rp.chapter_id is null then 0
                 else least(
                   1,
                   greatest(
                     0,
                     ((greatest(coalesce(rc.chapter_index, 1), 1) - 1) + least(1, greatest(0, rp.chapter_progress)))
                       / greatest(b.total_chapters, 1)::double precision
                   )
                 )
               end as last_read_progress,
               rp.updated_at as last_read_at,
               exists(select 1 from book_id_generations identity
                      where identity.user_id = b.user_id and identity.book_id = b.id and identity.generation > 1)
                 as has_prior_purge
        from library_books b
        left join book_objects o on o.id = b.object_id
        left join book_assets ca on ca.id = b.cover_asset_id
        left join reading_positions rp on rp.book_id = b.id and rp.user_id = b.user_id
        left join chapters rc on rc.id = rp.chapter_id and rc.book_id = b.id
        where b.id = $1 and b.user_id = $2 and b.deleted_at is null
      `,
      [request.params.bookId, config.defaultUserId],
    );
    if (!book.rows[0]) return reply.code(404).send({ error: 'book not found' });
    const revisionRow = book.rows[0] as ContentReadRevisionRow;
    const conflict = contentReadRevisionConflict(
      revisionRow,
      expectedContentReadRevision(request.query.contentRevisionId),
    );
    if (conflict) return sendContentReadRevisionConflict(reply, conflict, revisionRow);

    const position = await pool.query('select * from reading_positions where book_id = $1 and user_id = $2', [
      request.params.bookId,
      config.defaultUserId,
    ]);

    const { has_prior_purge: _priorPurge, ...manifestBook } = book.rows[0];
    const response = mapManifestResponse([manifestBook], position.rows);
    const contentRevisionId = canonicalContentReadRevision(revisionRow);
    return { ...response, ...(contentRevisionId ? { contentRevisionId } : {}) };
    },
  );

  app.get<{ Params: { bookId: string }; Querystring: { contentRevisionId?: string } }>(
    '/api/books/:bookId/chapters',
    async (request, reply) => {
    const result = await pool.query(
      `
        select b.active_content_revision_id,
               exists(select 1 from book_id_generations identity
                      where identity.user_id = b.user_id and identity.book_id = b.id and identity.generation > 1)
                 as has_prior_purge,
               c.id, c.book_id, c.chapter_index, c.title, c.text_hash, c.raw_start_offset, c.raw_end_offset,
               c.character_count, c.paragraph_count, c.document_section_id, c.document_section_title,
               c.document_section_index, c.document_page_index_in_section,
               section_state.last_read_at as document_section_read_at,
               c.created_at, c.updated_at
        from chapters c
        right join library_books b on b.id = c.book_id
        left join fixed_document_section_read_states section_state
          on section_state.book_id = c.book_id
         and section_state.user_id = $2
         and section_state.document_section_id = c.document_section_id
        where b.id = $1 and b.user_id = $2 and b.deleted_at is null
        order by c.chapter_index asc
      `,
      [request.params.bookId, config.defaultUserId],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'book not found' });
    const revisionRow = result.rows[0] as ContentReadRevisionRow;
    const conflict = contentReadRevisionConflict(
      revisionRow,
      expectedContentReadRevision(request.query.contentRevisionId),
    );
    if (conflict) return sendContentReadRevisionConflict(reply, conflict, revisionRow);
    const chapterRows = result.rows
      .filter((row) => typeof row.id === 'string')
      .map((row) => withoutContentReadRevision(row));
    const contentRevisionId = canonicalContentReadRevision(revisionRow);
    return {
      chapters: mapChapterRows(chapterRows),
      ...(contentRevisionId ? { contentRevisionId } : {}),
    };
    },
  );

  app.get<{ Params: { chapterId: string }; Querystring: { contentRevisionId?: string } }>(
    '/api/chapters/:chapterId',
    async (request, reply) => {
    const result = await pool.query(
      `
        select b.active_content_revision_id,
               exists(select 1 from book_id_generations identity
                      where identity.user_id = b.user_id and identity.book_id = b.id and identity.generation > 1)
                 as has_prior_purge,
               c.id, c.book_id, c.chapter_index, c.title, c.text_hash, c.raw_start_offset,
               c.raw_end_offset, c.character_count, c.paragraph_count, c.document_section_id,
               c.document_section_title, c.document_section_index, c.document_page_index_in_section,
               section_state.last_read_at as document_section_read_at,
               c.created_at, c.updated_at
        from chapters c
        join library_books b on b.id = c.book_id
        left join fixed_document_section_read_states section_state
          on section_state.book_id = c.book_id
         and section_state.user_id = b.user_id
         and section_state.document_section_id = c.document_section_id
        where c.id = $1 and b.user_id = $2 and b.deleted_at is null
      `,
      [request.params.chapterId, config.defaultUserId],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'chapter not found' });
    const revisionRow = result.rows[0] as ContentReadRevisionRow;
    const conflict = contentReadRevisionConflict(
      revisionRow,
      expectedContentReadRevision(request.query.contentRevisionId),
    );
    if (conflict) return sendContentReadRevisionConflict(reply, conflict, revisionRow);
    const contentRevisionId = canonicalContentReadRevision(revisionRow);
    return {
      chapter: mapChapterRows([withoutContentReadRevision(result.rows[0])])[0],
      ...(contentRevisionId ? { contentRevisionId } : {}),
    };
    },
  );

  app.get<{
    Params: { chapterId: string };
    Querystring: { from?: string; count?: string; contentRevisionId?: string };
  }>(
    '/api/chapters/:chapterId/pages',
    async (request, reply) => {
      const from = Math.max(0, Number.parseInt(request.query.from ?? '0', 10) || 0);
      const count = Math.min(20, Math.max(1, Number.parseInt(request.query.count ?? '5', 10) || 5));
      const result = await pool.query(
        `
          select b.active_content_revision_id,
                 exists(select 1 from book_id_generations identity
                        where identity.user_id = b.user_id and identity.book_id = b.id and identity.generation > 1)
                   as has_prior_purge,
                 pp.id, pp.book_id, pp.chapter_id, pp.page_index, pp.start_paragraph_index,
                 pp.end_paragraph_index, pp.paragraphs, pp.text_hash
          from chapters c
          join library_books b on b.id = c.book_id
          left join paragraph_pages pp on pp.chapter_id = c.id and pp.page_index >= $3
          where c.id = $1 and b.user_id = $2 and b.deleted_at is null
          order by pp.page_index asc
          limit $4
        `,
        [request.params.chapterId, config.defaultUserId, from, count],
      );
      if (!result.rows[0]) return reply.code(404).send({ error: 'chapter not found' });
      const revisionRow = result.rows[0] as ContentReadRevisionRow;
      const conflict = contentReadRevisionConflict(
        revisionRow,
        expectedContentReadRevision(request.query.contentRevisionId),
      );
      if (conflict) return sendContentReadRevisionConflict(reply, conflict, revisionRow);
      const pageRows = result.rows
        .filter((row) => typeof row.id === 'string')
        .map((row) => withoutContentReadRevision(row));
      const contentRevisionId = canonicalContentReadRevision(revisionRow);
      return { pages: mapPageRows(pageRows), ...(contentRevisionId ? { contentRevisionId } : {}) };
    },
  );

  app.get<{ Params: { paragraphId: string }; Querystring: { contentRevisionId?: string } }>(
    '/api/paragraphs/:paragraphId',
    async (request, reply) => {
    const result = await pool.query(
      `
          select b.active_content_revision_id,
                 exists(select 1 from book_id_generations identity
                        where identity.user_id = b.user_id and identity.book_id = b.id and identity.generation > 1)
                   as has_prior_purge,
                 ps.paragraph
          from paragraph_search ps
          join library_books b on b.id = ps.book_id
          where b.user_id = $1 and b.deleted_at is null and ps.paragraph_id = $2
          limit 1
        `,
      [config.defaultUserId, request.params.paragraphId],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'paragraph not found' });
    const revisionRow = result.rows[0] as ContentReadRevisionRow;
    const conflict = contentReadRevisionConflict(
      revisionRow,
      expectedContentReadRevision(request.query.contentRevisionId),
    );
    if (conflict) return sendContentReadRevisionConflict(reply, conflict, revisionRow);
    const contentRevisionId = canonicalContentReadRevision(revisionRow);
    return {
      paragraph: mapParagraphSearchRows([
        withoutContentReadRevision(result.rows[0]) as { paragraph: unknown },
      ])[0],
      ...(contentRevisionId ? { contentRevisionId } : {}),
    };
    },
  );
}
