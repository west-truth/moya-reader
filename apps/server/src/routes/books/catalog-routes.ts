import type { FastifyInstance, FastifyRequest } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { createS3Client, deleteObject, getObjectStream, putRawBookObject } from '../../services/object-storage.js';
import { integrityHash, persistentId128 } from '@noveldesk/text-core/hash';
import { mapBookCatalogRows } from './row-mappers.js';
import { validateBookPatchBody, type BookPatchBody } from './request-contracts.js';
import { createServerRevision, insertServerSyncEvent } from './sync-event-repository.js';

interface LifecycleBody {
  expectedRevision?: number;
  deviceId?: string;
}

const catalogSelect = `
  select b.id, b.active_content_revision_id, b.format, b.title, b.author, b.series_title, b.series_index, b.tags,
         b.description, b.language, b.cover_asset_id, b.cover_fit, b.cover_position_x, b.cover_position_y,
         b.source_file_name, b.source_encoding,
         b.normalized_text_hash, b.total_chapters, b.total_characters, b.total_paragraphs, b.cover_seed,
         b.analysis_status, b.favorite, b.metadata_revision, b.deleted_at, b.deleted_by_device_id,
         b.created_at, b.updated_at,
         o.id as source_asset_id, o.raw_text_hash as source_content_hash,
         o.content_type as source_content_type, o.size_bytes as source_byte_length,
         ca.content_hash as cover_content_hash,
         rp.chapter_id as last_read_chapter_id, rp.paragraph_id as last_read_paragraph_id,
         rp.scroll_top as last_read_offset, rp.chapter_progress as last_read_progress
  from library_books b
  left join book_objects o on o.id = b.object_id
  left join book_assets ca on ca.id = b.cover_asset_id
  left join reading_positions rp on rp.book_id = b.id and rp.user_id = b.user_id
`;

function expectedRevision(request: FastifyRequest, body?: LifecycleBody): number | undefined {
  const bodyRevision = body?.expectedRevision;
  if (Number.isSafeInteger(bodyRevision) && Number(bodyRevision) >= 0) return Number(bodyRevision);
  const raw = request.headers['if-match'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const normalized = value.replace(/^W\//, '').replaceAll('"', '').trim();
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function lifecycleRevisionConflict(reply: { code(statusCode: number): { send(payload: unknown): unknown } }) {
  return reply.code(409).send({ error: 'book metadata revision changed' });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseSingleByteRange(value: string, byteLength: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : byteLength - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= byteLength) {
    return undefined;
  }
  return { start, end: Math.min(byteLength - 1, Math.max(start, requestedEnd)) };
}

function normalizedSha256(value: string): string | undefined {
  if (/^sha256:[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  if (/^[0-9a-f]{64}$/i.test(value)) return `sha256:${value.toLowerCase()}`;
  return undefined;
}

function downloadContentDisposition(fileName: string): string {
  const fallback = Array.from(fileName, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code > 126 || '\\/:*?"<>|'.includes(character) ? '_' : character;
  })
    .join('')
    .slice(0, 180);
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback || 'moya-source'}"; filename*=UTF-8''${encoded}`;
}

async function emitLifecycleEvent(
  client: pg.PoolClient,
  userId: string,
  input: {
    type: 'book_trashed' | 'book_restored' | 'book_purged';
    bookId: string;
    changedAt: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await insertServerSyncEvent(client, userId, {
    seed: `${input.type}:${input.bookId}:${input.changedAt}`,
    type: input.type,
    bookId: input.bookId,
    entityId: input.bookId,
    payload: input.payload,
    revision: createServerRevision({
      entityType: 'book',
      entityId: input.bookId,
      novelId: input.bookId,
      updatedAt: input.changedAt,
      ...(input.type === 'book_purged' ? { deletedAt: input.changedAt } : undefined),
      payload: input.payload,
    }),
    createdAt: input.changedAt,
  });
}

export async function registerBookCatalogRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  app.get<{
    Querystring: {
      shelfId?: string;
      filter?: 'all' | 'reading' | 'finished' | 'unread' | 'favorite';
      search?: string;
      sort?: 'recent' | 'title' | 'added';
      cursor?: string;
      limit?: string;
    };
  }>('/api/books', async (request, reply) => {
    const query = request.query ?? {};
    const cursor = Math.max(0, Number.parseInt(query.cursor ?? '0', 10) || 0);
    const limit = Math.max(1, Math.min(1_000, Number.parseInt(query.limit ?? '1000', 10) || 1_000));
    if (query.filter && !['all', 'reading', 'finished', 'unread', 'favorite'].includes(query.filter)) {
      return reply.code(400).send({ error: 'invalid library filter' });
    }
    if (query.sort && !['recent', 'title', 'added'].includes(query.sort)) {
      return reply.code(400).send({ error: 'invalid library sort' });
    }
    const values: unknown[] = [config.defaultUserId];
    const conditions = ['b.user_id = $1', 'b.deleted_at is null'];
    if (query.shelfId) {
      values.push(query.shelfId);
      conditions.push(
        `exists (select 1 from shelf_memberships sm where sm.book_id = b.id and sm.user_id = b.user_id and sm.shelf_id = $${values.length})`,
      );
    }
    const search = query.search?.trim();
    if (search) {
      values.push(`%${search}%`);
      conditions.push(
        `(b.title ilike $${values.length} or coalesce(b.author, '') ilike $${values.length} or coalesce(b.series_title, '') ilike $${values.length} or b.tags::text ilike $${values.length})`,
      );
    }
    if (query.filter === 'favorite') conditions.push('b.favorite = true');
    if (query.filter === 'reading')
      conditions.push('coalesce(rp.chapter_progress, 0) > 0 and coalesce(rp.chapter_progress, 0) < 0.995');
    if (query.filter === 'finished') conditions.push('coalesce(rp.chapter_progress, 0) >= 0.995');
    if (query.filter === 'unread') conditions.push('coalesce(rp.chapter_progress, 0) = 0');
    const orderBy =
      query.sort === 'title'
        ? 'lower(b.title), b.id'
        : query.sort === 'added'
          ? 'b.created_at desc, b.id'
          : 'greatest(b.updated_at, coalesce(rp.updated_at, b.updated_at)) desc, b.id';
    values.push(limit + 1, cursor);
    const result = await pool.query(
      `${catalogSelect}
       where ${conditions.join(' and ')}
       order by ${orderBy}
       limit $${values.length - 1} offset $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > limit;
    return {
      books: mapBookCatalogRows(result.rows.slice(0, limit)),
      nextCursor: hasMore ? String(cursor + limit) : undefined,
    };
  });

  app.get('/api/trash/books', async () => {
    const result = await pool.query(
      `${catalogSelect}
       where b.user_id = $1 and b.deleted_at is not null
       order by b.deleted_at desc`,
      [config.defaultUserId],
    );
    return { books: mapBookCatalogRows(result.rows) };
  });

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/source/metadata', async (request, reply) => {
    const result = await pool.query(
      `
        select o.id, b.id as book_id, b.active_content_revision_id as content_revision_id,
               o.file_name, o.content_type, o.size_bytes, o.raw_text_hash,
               b.source_encoding, o.created_at
        from library_books b
        join book_objects o on o.id = b.object_id
        where b.id = $1 and b.user_id = $2 and b.deleted_at is null
      `,
      [request.params.bookId, config.defaultUserId],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'source not found' });
    return { source: result.rows[0] };
  });

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/source', async (request, reply) => {
    const result = await pool.query(
      `
        select o.storage_key, o.file_name, o.content_type, o.size_bytes, o.raw_text_hash
        from library_books b
        join book_objects o on o.id = b.object_id
        where b.id = $1 and b.user_id = $2 and b.deleted_at is null
      `,
      [request.params.bookId, config.defaultUserId],
    );
    const source = result.rows[0];
    if (!source) return reply.code(404).send({ error: 'source not found' });
    const byteLength = Number(source.size_bytes);
    const etag = `"${String(source.raw_text_hash)}"`;
    const rangeHeader = singleHeader(request.headers.range);
    const ifRange = singleHeader(request.headers['if-range']);
    const requestedRange =
      rangeHeader && (!ifRange || ifRange === etag) ? parseSingleByteRange(rangeHeader, byteLength) : undefined;
    if (rangeHeader && (!ifRange || ifRange === etag) && !requestedRange) {
      return reply.header('Content-Range', `bytes */${byteLength}`).code(416).send();
    }
    const stored = await getObjectStream(
      createS3Client(config),
      config,
      String(source.storage_key),
      requestedRange ? { startInclusive: requestedRange.start, endInclusive: requestedRange.end } : undefined,
    );
    const fileName = String(source.file_name);
    const responseByteLength = requestedRange ? requestedRange.end - requestedRange.start + 1 : byteLength;
    const response = reply
      .header('Content-Type', String(source.content_type || stored.contentType || 'application/octet-stream'))
      .header('Content-Length', String(responseByteLength))
      .header('Accept-Ranges', 'bytes')
      .header('ETag', etag)
      .header('Content-Disposition', downloadContentDisposition(fileName))
      .header('X-Source-File-Name', encodeURIComponent(fileName))
      .header('X-Source-Content-Hash', String(source.raw_text_hash));
    if (requestedRange) {
      response.header('Content-Range', `bytes ${requestedRange.start}-${requestedRange.end}/${byteLength}`).code(206);
    }
    return response.send(stored.body);
  });

  app.put<{ Params: { bookId: string }; Body: Buffer }>(
    '/api/books/:bookId/source',
    { bodyLimit: config.maxUploadBytes },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
        return reply.code(400).send({ error: 'source body is missing' });
      }
      const encodedFileName = singleHeader(request.headers['x-source-file-name']);
      const fileName = encodedFileName ? decodeURIComponent(encodedFileName) : 'source.txt';
      const contentType = singleHeader(request.headers['x-source-content-type']) || 'text/plain';
      const client = await pool.connect();
      const s3 = createS3Client(config);
      let uploadedKey: string | undefined;
      let orphanedKey: string | undefined;
      try {
        await client.query('begin');
        const current = await client.query(
          `select b.id, b.object_id, b.active_content_revision_id, b.source_encoding,
                  coalesce(r.source_raw_text_hash, o.raw_text_hash) as source_raw_text_hash
           from library_books b
           left join book_content_revisions r on r.id = b.active_content_revision_id and r.book_id = b.id
           left join book_objects o on o.id = b.object_id
           where b.id = $1 and b.user_id = $2 and b.deleted_at is null
           for update of b`,
          [request.params.bookId, config.defaultUserId],
        );
        const book = current.rows[0];
        if (!book) {
          await client.query('rollback');
          return reply.code(404).send({ error: 'book not found' });
        }
        const expectedHash = normalizedSha256(String(book.source_raw_text_hash || ''));
        const contentHash = integrityHash(request.body);
        if (!expectedHash || expectedHash !== contentHash) {
          await client.query('rollback');
          return reply.code(409).send({ error: 'selected source does not match the imported book' });
        }

        const existing = await client.query(
          `select id, storage_key, file_name, content_type, size_bytes, created_at
           from book_objects where raw_text_hash = $1`,
          [contentHash],
        );
        let objectId: string;
        if (existing.rows[0]) {
          objectId = String(existing.rows[0].id);
        } else {
          objectId = persistentId128('object', [contentHash]);
          uploadedKey = `${config.defaultUserId}/${objectId}/${fileName}`;
          await putRawBookObject(s3, config, uploadedKey, request.body, contentType);
          await client.query(
            `insert into book_objects (id, raw_text_hash, storage_key, file_name, content_type, size_bytes)
             values ($1, $2, $3, $4, $5, $6)`,
            [objectId, contentHash, uploadedKey, fileName, contentType, request.body.byteLength],
          );
        }
        await client.query(
          `update library_books
           set object_id = $1, source_file_name = $2, metadata_revision = metadata_revision + 1, updated_at = now()
           where id = $3 and user_id = $4`,
          [objectId, fileName, request.params.bookId, config.defaultUserId],
        );
        if (book.active_content_revision_id) {
          await client.query(
            `update book_content_revisions
             set source_object_id = $1, source_file_name = $2, source_raw_text_hash = $3
             where id = $4 and book_id = $5`,
            [objectId, fileName, contentHash, book.active_content_revision_id, request.params.bookId],
          );
        }
        if (book.object_id && String(book.object_id) !== objectId) {
          const orphan = await client.query(
            `delete from book_objects o
             where o.id = $1 and not exists (select 1 from library_books b where b.object_id = o.id)
             returning storage_key`,
            [book.object_id],
          );
          if (orphan.rows[0]) orphanedKey = String(orphan.rows[0].storage_key);
        }
        const source = await client.query(
          `select o.id, b.id as book_id, b.active_content_revision_id as content_revision_id,
                  o.storage_key, o.file_name, o.content_type, o.size_bytes, o.raw_text_hash,
                  b.source_encoding, o.created_at
           from library_books b join book_objects o on o.id = b.object_id
           where b.id = $1 and b.user_id = $2`,
          [request.params.bookId, config.defaultUserId],
        );
        await client.query('commit');
        if (orphanedKey) await deleteObject(s3, config, orphanedKey).catch(() => undefined);
        return { source: source.rows[0] };
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        if (uploadedKey) await deleteObject(s3, config, uploadedKey).catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.patch<{ Params: { bookId: string }; Body: BookPatchBody }>('/api/books/:bookId', async (request, reply) => {
    const parsed = validateBookPatchBody(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const value = parsed.value;
    const client = await pool.connect();
    try {
      await client.query('begin');
      const updated = await client.query(
        `update library_books
         set title = coalesce($1, title),
             author = case when $2 then $3 else author end,
             series_title = case when $4 then $5 else series_title end,
             series_index = case when $6 then $7 else series_index end,
             tags = case when $8 then $9::jsonb else tags end,
             description = case when $10 then $11 else description end,
             language = case when $12 then $13 else language end,
             favorite = coalesce($14, favorite),
             analysis_status = coalesce($15, analysis_status),
             cover_fit = coalesce($16, cover_fit),
             cover_position_x = coalesce($17, cover_position_x),
             cover_position_y = coalesce($18, cover_position_y),
             metadata_revision = metadata_revision + 1,
             updated_at = now()
         where id = $19 and user_id = $20 and deleted_at is null
           and ($21::bigint is null or metadata_revision = $21)
         returning title, author, series_title, series_index, tags, description, language,
                   cover_asset_id, cover_fit, cover_position_x, cover_position_y, favorite,
                   analysis_status, metadata_revision, updated_at`,
        [
          value.title ?? null,
          value.author !== undefined,
          value.author ?? null,
          value.seriesTitle !== undefined,
          value.seriesTitle ?? null,
          value.seriesIndex !== undefined,
          value.seriesIndex ?? null,
          value.tags !== undefined,
          JSON.stringify(value.tags ?? []),
          value.description !== undefined,
          value.description ?? null,
          value.language !== undefined,
          value.language ?? null,
          value.favorite ?? null,
          value.analysisStatus ?? null,
          value.coverFit ?? null,
          value.coverPositionX ?? null,
          value.coverPositionY ?? null,
          request.params.bookId,
          config.defaultUserId,
          value.expectedRevision ?? null,
        ],
      );
      if (!updated.rows[0]) {
        const existing = await client.query(
          'select metadata_revision from library_books where id = $1 and user_id = $2 and deleted_at is null',
          [request.params.bookId, config.defaultUserId],
        );
        await client.query('rollback');
        return existing.rows[0] && value.expectedRevision !== undefined
          ? lifecycleRevisionConflict(reply)
          : reply.code(404).send({ error: 'book not found' });
      }
      const row = updated.rows[0];
      const updatedAt = new Date(row.updated_at).toISOString();
      const novel = {
        id: request.params.bookId,
        title: String(row.title),
        author: row.author,
        seriesTitle: row.series_title,
        seriesIndex: row.series_index === null ? null : Number(row.series_index),
        tags: row.tags,
        description: row.description,
        language: row.language,
        coverAssetId: row.cover_asset_id,
        coverFit: row.cover_fit,
        coverPositionX: Number(row.cover_position_x),
        coverPositionY: Number(row.cover_position_y),
        favorite: Boolean(row.favorite),
        analysisStatus: String(row.analysis_status),
        metadataRevision: Number(row.metadata_revision),
        updatedAt,
      };
      const payload = { novel };
      await insertServerSyncEvent(client, config.defaultUserId, {
        seed: `book_updated:${request.params.bookId}:${updatedAt}`,
        type: 'book_updated',
        bookId: request.params.bookId,
        entityId: request.params.bookId,
        payload,
        revision: createServerRevision({
          entityType: 'book',
          entityId: request.params.bookId,
          novelId: request.params.bookId,
          updatedAt,
          payload,
        }),
        createdAt: updatedAt,
      });
      await client.query('commit');
      return { ok: true, metadataRevision: novel.metadataRevision };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete<{ Params: { bookId: string }; Body: LifecycleBody }>('/api/books/:bookId', async (request, reply) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const expected = expectedRevision(request, request.body);
      const result = await client.query(
        `
          update library_books
          set deleted_at = now(),
              deleted_by_device_id = $3,
              metadata_revision = metadata_revision + 1,
              updated_at = now()
          where id = $1 and user_id = $2 and deleted_at is null
            and ($4::bigint is null or metadata_revision = $4)
          returning id, deleted_at, metadata_revision
        `,
        [request.params.bookId, config.defaultUserId, request.body?.deviceId ?? 'server', expected ?? null],
      );
      if (!result.rows[0]) {
        const exists = await client.query(
          'select metadata_revision from library_books where id = $1 and user_id = $2',
          [request.params.bookId, config.defaultUserId],
        );
        await client.query('rollback');
        return exists.rows[0] && expected !== undefined
          ? lifecycleRevisionConflict(reply)
          : reply.code(404).send({ error: 'book not found' });
      }
      const deletedAt = new Date(result.rows[0].deleted_at).toISOString();
      const metadataRevision = Number(result.rows[0].metadata_revision);
      const payload = {
        bookId: request.params.bookId,
        deletedAt,
        deletedByDeviceId: request.body?.deviceId ?? 'server',
        metadataRevision,
      };
      await emitLifecycleEvent(client, config.defaultUserId, {
        type: 'book_trashed',
        bookId: request.params.bookId,
        changedAt: deletedAt,
        payload,
      });
      await client.query('commit');
      return { ok: true, metadataRevision };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post<{ Params: { bookId: string }; Body: LifecycleBody }>(
    '/api/trash/books/:bookId/restore',
    async (request, reply) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const expected = expectedRevision(request, request.body);
        const result = await client.query(
          `
            update library_books
            set deleted_at = null,
                deleted_by_device_id = null,
                metadata_revision = metadata_revision + 1,
                updated_at = now()
            where id = $1 and user_id = $2 and deleted_at is not null
              and ($3::bigint is null or metadata_revision = $3)
            returning id, updated_at, metadata_revision
          `,
          [request.params.bookId, config.defaultUserId, expected ?? null],
        );
        if (!result.rows[0]) {
          await client.query('rollback');
          return expected !== undefined
            ? lifecycleRevisionConflict(reply)
            : reply.code(404).send({ error: 'book not found' });
        }
        const restoredAt = new Date(result.rows[0].updated_at).toISOString();
        const metadataRevision = Number(result.rows[0].metadata_revision);
        await emitLifecycleEvent(client, config.defaultUserId, {
          type: 'book_restored',
          bookId: request.params.bookId,
          changedAt: restoredAt,
          payload: { bookId: request.params.bookId, restoredAt, metadataRevision },
        });
        await client.query('commit');
        return { ok: true, metadataRevision };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.delete<{ Params: { bookId: string }; Body: LifecycleBody }>(
    '/api/trash/books/:bookId',
    async (request, reply) => {
      const client = await pool.connect();
      let objectToDelete: { storageKey: string } | undefined;
      try {
        await client.query('begin');
        const expected = expectedRevision(request, request.body);
        const result = await client.query(
          `
            delete from library_books
            where id = $1 and user_id = $2 and deleted_at is not null
              and ($3::bigint is null or metadata_revision = $3)
            returning id, object_id, metadata_revision
          `,
          [request.params.bookId, config.defaultUserId, expected ?? null],
        );
        if (!result.rows[0]) {
          await client.query('rollback');
          return expected !== undefined
            ? lifecycleRevisionConflict(reply)
            : reply.code(404).send({ error: 'book not found' });
        }
        const purgedAt = new Date().toISOString();
        const metadataRevision = Number(result.rows[0].metadata_revision) + 1;
        await emitLifecycleEvent(client, config.defaultUserId, {
          type: 'book_purged',
          bookId: request.params.bookId,
          changedAt: purgedAt,
          payload: { bookId: request.params.bookId, purgedAt, metadataRevision },
        });
        if (result.rows[0].object_id) {
          const object = await client.query(
            `
              delete from book_objects o
              where o.id = $1 and not exists (select 1 from library_books b where b.object_id = o.id)
              returning o.storage_key
            `,
            [result.rows[0].object_id],
          );
          if (object.rows[0]) objectToDelete = { storageKey: String(object.rows[0].storage_key) };
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      if (objectToDelete) {
        await deleteObject(createS3Client(config), config, objectToDelete.storageKey).catch((error) => {
          app.log.warn({ error, storageKey: objectToDelete?.storageKey }, 'failed to remove purged source object');
        });
      }
      return { ok: true };
    },
  );

  app.delete('/api/trash/books', async () => {
    const client = await pool.connect();
    const storageKeys: string[] = [];
    let purged: number | undefined;
    try {
      await client.query('begin');
      const result = await client.query(
        `
          delete from library_books
          where user_id = $1 and deleted_at is not null
          returning id, object_id, metadata_revision
        `,
        [config.defaultUserId],
      );
      purged = result.rows.length;
      const purgedAt = new Date().toISOString();
      for (const row of result.rows) {
        const bookId = String(row.id);
        await emitLifecycleEvent(client, config.defaultUserId, {
          type: 'book_purged',
          bookId,
          changedAt: purgedAt,
          payload: { bookId, purgedAt, metadataRevision: Number(row.metadata_revision) + 1 },
        });
      }
      const objectIds = result.rows.map((row) => row.object_id).filter(Boolean);
      if (objectIds.length > 0) {
        const objects = await client.query(
          `
            delete from book_objects o
            where o.id = any($1::text[])
              and not exists (select 1 from library_books b where b.object_id = o.id)
            returning o.storage_key
          `,
          [objectIds],
        );
        storageKeys.push(...objects.rows.map((row) => String(row.storage_key)));
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    const s3 = storageKeys.length > 0 ? createS3Client(config) : undefined;
    for (const storageKey of storageKeys) {
      await deleteObject(s3!, config, storageKey).catch((error) => {
        app.log.warn({ error, storageKey }, 'failed to remove purged source object');
      });
    }
    return { ok: true, purged: purged ?? 0 };
  });
}
