import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { detectCoverContentType } from '@noveldesk/text-core/image-format';
import { integrityHash, persistentId128 } from '@noveldesk/text-core/hash';
import type { ServerConfig } from '../../config.js';
import { createS3Client, deleteObject, getObjectBuffer, putRawBookObject } from '../../services/object-storage.js';
import { createServerRevision, insertServerSyncEvent } from './sync-event-repository.js';

interface CoverHeaders {
  'x-cover-file-name'?: string;
  'x-cover-content-type'?: string;
  'x-cover-content-hash'?: string;
  'x-cover-width'?: string;
  'x-cover-height'?: string;
  'x-cover-fit'?: string;
  'x-cover-position-x'?: string;
  'x-cover-position-y'?: string;
  'x-cover-provenance'?: string;
  'x-expected-metadata-revision'?: string;
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function boundedNumber(value: string | undefined, min: number, max: number): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function expectedRevision(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function generatedCoverCanReplace(currentProvenance: unknown): boolean {
  return currentProvenance === undefined || currentProvenance === null || currentProvenance === 'generated_preview';
}

export function isWritableCoverProvenance(
  value: unknown,
): value is 'user_supplied' | 'approved_enrichment' | 'generated_preview' {
  return value === 'user_supplied' || value === 'approved_enrichment' || value === 'generated_preview';
}

async function coverRow(pool: pg.Pool, userId: string, bookId: string) {
  return (
    await pool.query(
      `select asset.* from book_assets asset
       join library_books book on book.id = asset.book_id and book.cover_asset_id = asset.id
       where asset.book_id = $1 and asset.user_id = $2 and asset.kind = 'cover' and asset.status = 'active'
         and book.deleted_at is null`,
      [bookId, userId],
    )
  ).rows[0];
}

async function emitCoverSync(
  client: pg.PoolClient,
  userId: string,
  bookId: string,
  novel: Record<string, unknown>,
  updatedAt: string,
) {
  const payload = { novel };
  await insertServerSyncEvent(client, userId, {
    seed: `book_cover:${bookId}:${updatedAt}`,
    type: 'book_updated',
    bookId,
    entityId: bookId,
    payload,
    revision: createServerRevision({ entityType: 'book', entityId: bookId, novelId: bookId, updatedAt, payload }),
    createdAt: updatedAt,
  });
}

export async function registerBookCoverRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/cover/metadata', async (request, reply) => {
    const cover = await coverRow(pool, config.defaultUserId, request.params.bookId);
    return cover ? { cover } : reply.code(404).send({ error: 'cover not found' });
  });

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/cover', async (request, reply) => {
    const cover = await coverRow(pool, config.defaultUserId, request.params.bookId);
    if (!cover) return reply.code(404).send({ error: 'cover not found' });
    const stored = await getObjectBuffer(createS3Client(config), config, String(cover.storage_key));
    return reply
      .header('Content-Type', String(cover.content_type))
      .header('Content-Length', stored.body.byteLength)
      .header('ETag', String(cover.content_hash))
      .send(stored.body);
  });

  app.put<{ Params: { bookId: string }; Headers: CoverHeaders; Body: Buffer }>(
    '/api/books/:bookId/cover',
    { bodyLimit: 10 * 1024 * 1024 },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        return reply.code(400).send({ error: 'cover body is required' });
      }
      const detectedType = detectCoverContentType(request.body.subarray(0, 16));
      const declaredType = header(request.headers['x-cover-content-type']);
      if (!detectedType || detectedType !== declaredType) {
        return reply.code(400).send({ error: 'cover must be a matching JPEG, PNG or WebP image' });
      }
      const width = boundedNumber(header(request.headers['x-cover-width']), 1, 1200);
      const height = boundedNumber(header(request.headers['x-cover-height']), 1, 1800);
      const fit = header(request.headers['x-cover-fit']);
      const positionX = boundedNumber(header(request.headers['x-cover-position-x']), 0, 100);
      const positionY = boundedNumber(header(request.headers['x-cover-position-y']), 0, 100);
      const requestedProvenance = header(request.headers['x-cover-provenance']) ?? 'user_supplied';
      if (!isWritableCoverProvenance(requestedProvenance)) {
        return reply.code(400).send({ error: 'cover provenance is invalid' });
      }
      if (
        !width ||
        !height ||
        (fit !== 'crop' && fit !== 'contain') ||
        positionX === undefined ||
        positionY === undefined
      ) {
        return reply.code(400).send({ error: 'cover layout metadata is invalid' });
      }
      const contentHash = integrityHash(request.body);
      if (header(request.headers['x-cover-content-hash']) !== contentHash) {
        return reply.code(409).send({ error: 'cover content hash does not match' });
      }
      let fileName: string;
      try {
        fileName = decodeURIComponent(header(request.headers['x-cover-file-name']) ?? 'cover');
      } catch {
        return reply.code(400).send({ error: 'cover file name is invalid' });
      }
      const now = new Date().toISOString();
      const id = persistentId128('cover_asset', [request.params.bookId, contentHash, now]);
      const storageKey = `${config.defaultUserId}/${request.params.bookId}/covers/${id}/${fileName}`;
      await putRawBookObject(createS3Client(config), config, storageKey, request.body, detectedType);
      const client = await pool.connect();
      let previousKey: string | undefined;
      try {
        await client.query('begin');
        const bookResult = await client.query(
          `select id, cover_asset_id, metadata_revision from library_books
           where id = $1 and user_id = $2 and deleted_at is null for update`,
          [request.params.bookId, config.defaultUserId],
        );
        const book = bookResult.rows[0];
        if (!book) {
          await client.query('rollback');
          await deleteObject(createS3Client(config), config, storageKey).catch(() => undefined);
          return reply.code(404).send({ error: 'book not found' });
        }
        const expected = expectedRevision(header(request.headers['x-expected-metadata-revision']));
        if (expected !== undefined && expected !== Number(book.metadata_revision)) {
          await client.query('rollback');
          await deleteObject(createS3Client(config), config, storageKey).catch(() => undefined);
          return reply.code(409).send({ error: 'book metadata revision changed' });
        }
        if (book.cover_asset_id) {
          const current = (
            await client.query(
              'select storage_key, provenance, content_hash from book_assets where id = $1 for update',
              [book.cover_asset_id],
            )
          ).rows[0];
          if (requestedProvenance === 'generated_preview' && !generatedCoverCanReplace(current?.provenance)) {
            await client.query('rollback');
            await deleteObject(createS3Client(config), config, storageKey).catch(() => undefined);
            return reply.code(409).send({ error: 'generated cover cannot replace an authored cover' });
          }
          if (requestedProvenance === 'generated_preview' && current?.content_hash === contentHash) {
            await client.query('rollback');
            await deleteObject(createS3Client(config), config, storageKey).catch(() => undefined);
            return { cover: await coverRow(pool, config.defaultUserId, request.params.bookId) };
          }
          const previous = await client.query('delete from book_assets where id = $1 returning storage_key', [
            book.cover_asset_id,
          ]);
          previousKey = previous.rows[0] ? String(previous.rows[0].storage_key) : undefined;
        }
        await client.query(
          `insert into book_assets
             (id, user_id, book_id, kind, provenance, status, storage_key, file_name, content_type,
              byte_length, content_hash, pixel_width, pixel_height, created_at, activated_at)
           values ($1, $2, $3, 'cover', $4, 'active', $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
          [
            id,
            config.defaultUserId,
            request.params.bookId,
            requestedProvenance,
            storageKey,
            fileName,
            detectedType,
            request.body.byteLength,
            contentHash,
            width,
            height,
            now,
          ],
        );
        const updated = await client.query(
          `update library_books set cover_asset_id = $1, cover_fit = $2, cover_position_x = $3,
             cover_position_y = $4, metadata_revision = metadata_revision + 1, updated_at = $5
           where id = $6 and user_id = $7
           returning metadata_revision`,
          [id, fit, positionX, positionY, now, request.params.bookId, config.defaultUserId],
        );
        await emitCoverSync(
          client,
          config.defaultUserId,
          request.params.bookId,
          {
            id: request.params.bookId,
            coverAssetId: id,
            coverContentHash: contentHash,
            coverFit: fit,
            coverPositionX: positionX,
            coverPositionY: positionY,
            metadataRevision: Number(updated.rows[0].metadata_revision),
            updatedAt: now,
          },
          now,
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        await deleteObject(createS3Client(config), config, storageKey).catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      if (previousKey) await deleteObject(createS3Client(config), config, previousKey).catch(() => undefined);
      return { cover: await coverRow(pool, config.defaultUserId, request.params.bookId) };
    },
  );

  app.delete<{ Params: { bookId: string }; Body: { expectedRevision?: number } }>(
    '/api/books/:bookId/cover',
    async (request, reply) => {
      const client = await pool.connect();
      let storageKey: string | undefined;
      try {
        await client.query('begin');
        const bookResult = await client.query(
          `select id, cover_asset_id, metadata_revision from library_books
           where id = $1 and user_id = $2 and deleted_at is null for update`,
          [request.params.bookId, config.defaultUserId],
        );
        const book = bookResult.rows[0];
        if (!book) {
          await client.query('rollback');
          return reply.code(404).send({ error: 'book not found' });
        }
        if (
          request.body?.expectedRevision !== undefined &&
          request.body.expectedRevision !== Number(book.metadata_revision)
        ) {
          await client.query('rollback');
          return reply.code(409).send({ error: 'book metadata revision changed' });
        }
        if (!book.cover_asset_id) {
          await client.query('commit');
          return { ok: true as const };
        }
        const now = new Date().toISOString();
        await client.query(
          `update library_books set cover_asset_id = null, cover_fit = 'crop', cover_position_x = 50,
             cover_position_y = 50, metadata_revision = metadata_revision + 1, updated_at = $1
           where id = $2 and user_id = $3`,
          [now, request.params.bookId, config.defaultUserId],
        );
        const removed = await client.query('delete from book_assets where id = $1 returning storage_key', [
          book.cover_asset_id,
        ]);
        storageKey = removed.rows[0] ? String(removed.rows[0].storage_key) : undefined;
        await emitCoverSync(
          client,
          config.defaultUserId,
          request.params.bookId,
          {
            id: request.params.bookId,
            coverAssetId: null,
            coverContentHash: null,
            coverFit: 'crop',
            coverPositionX: 50,
            coverPositionY: 50,
            metadataRevision: Number(book.metadata_revision) + 1,
            updatedAt: now,
          },
          now,
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      if (storageKey) await deleteObject(createS3Client(config), config, storageKey).catch(() => undefined);
      return { ok: true };
    },
  );
}
