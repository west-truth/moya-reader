import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import pg from 'pg';
import { detectCoverContentType } from '@noveldesk/text-core/image-format';
import { integrityHash, persistentId128 } from '@noveldesk/text-core/hash';
import type { ServerConfig } from '../../config.js';
import { createS3Client, deleteObject, getObjectBuffer, putRawBookObject } from '../../services/object-storage.js';
import { lockImageSeriesBookLifecycle } from '../../services/book-operation-lock.js';
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
  'x-expected-content-revision-id'?: string;
}

interface ApprovedEnrichmentCoverRestoreBody {
  expectedMetadataRevision?: number;
  expectedContentRevisionId?: string;
  expectedActiveAssetId?: string;
  expectedActiveContentHash?: string;
  previousAssetId?: string;
  previousContentHash?: string;
  previousFit?: 'crop' | 'contain';
  previousPositionX?: number;
  previousPositionY?: number;
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

function expectedContentRevision(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

interface CoverMutationBookRow {
  active_content_revision_id?: unknown;
  has_prior_purge?: unknown;
}

export function coverContentRevisionConflict(
  book: CoverMutationBookRow,
  expectedContentRevisionId: string | undefined,
): 'content_revision_required' | 'content_revision_changed' | undefined {
  if (!expectedContentRevisionId) return book.has_prior_purge ? 'content_revision_required' : undefined;
  return book.active_content_revision_id === expectedContentRevisionId ? undefined : 'content_revision_changed';
}

function contentRevisionError(reply: FastifyReply, conflict: ReturnType<typeof coverContentRevisionConflict>) {
  if (conflict === 'content_revision_required') {
    return reply.code(409).send({ error: 'book content revision is required' });
  }
  return reply.code(409).send({ error: 'book content revision changed' });
}

function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
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

async function deleteUploadedCoverIfUnreferenced(
  pool: pg.Pool,
  config: ServerConfig,
  assetId: string,
  storageKey: string,
): Promise<void> {
  try {
    const referenced = await pool.query('select 1 from book_assets where id = $1 and storage_key = $2 limit 1', [
      assetId,
      storageKey,
    ]);
    if (referenced.rows.length > 0) return;
  } catch {
    // An unconfirmed row is safer as a leaked object than a committed cover with missing bytes.
    return;
  }
  await deleteObject(createS3Client(config), config, storageKey).catch(() => undefined);
}

async function emitCoverSync(
  client: pg.PoolClient,
  userId: string,
  bookId: string,
  novel: Record<string, unknown>,
  contentRevisionId: string | undefined,
  updatedAt: string,
) {
  const payload = { novel, contentRevisionId };
  const revision = createServerRevision({
    entityType: 'book',
    entityId: bookId,
    novelId: bookId,
    updatedAt,
    payload,
  });
  await insertServerSyncEvent(client, userId, {
    seed: `book_cover:${bookId}:${updatedAt}:${revision.payloadHash}`,
    type: 'book_updated',
    bookId,
    entityId: bookId,
    payload,
    revision,
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
      .header('Cache-Control', 'private, no-cache')
      .header('X-Asset-Id', String(cover.id))
      .header('X-Asset-Provenance', String(cover.provenance))
      .header('X-Asset-Status', String(cover.status))
      .header('X-Asset-File-Name', encodeURIComponent(String(cover.file_name ?? 'cover')))
      .header('X-Asset-Content-Hash', String(cover.content_hash))
      .header('X-Asset-Pixel-Width', cover.pixel_width == null ? '' : String(cover.pixel_width))
      .header('X-Asset-Pixel-Height', cover.pixel_height == null ? '' : String(cover.pixel_height))
      .header('X-Asset-Created-At', isoTimestamp(cover.created_at))
      .header('X-Asset-Activated-At', cover.activated_at == null ? '' : isoTimestamp(cover.activated_at))
      .send(stored.body);
  });

  const saveCover = async (
    request: FastifyRequest<{ Params: { bookId: string }; Headers: CoverHeaders; Body: Buffer }>,
    reply: FastifyReply,
    forcedProvenance?: 'approved_enrichment',
  ) => {
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
    const requestedProvenance = forcedProvenance ?? header(request.headers['x-cover-provenance']) ?? 'user_supplied';
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
    const rawExpectedContentRevisionId = header(request.headers['x-expected-content-revision-id']);
    const expectedContentRevisionId = expectedContentRevision(rawExpectedContentRevisionId);
    if (rawExpectedContentRevisionId !== undefined && !expectedContentRevisionId) {
      return reply.code(400).send({ error: 'expected content revision id is invalid' });
    }
    const now = new Date().toISOString();
    const id = persistentId128('cover_asset', [request.params.bookId, contentHash, now]);
    const storageKey = `${config.defaultUserId}/${request.params.bookId}/covers/${id}/${fileName}`;
    await putRawBookObject(createS3Client(config), config, storageKey, request.body, detectedType);
    const client = await pool.connect();
    let previousKey: string | undefined;
    let previousCover: Record<string, unknown> | undefined;
    let metadataRevision = 0;
    let transactionFailed = false;
    let transactionError: unknown;
    let commitAttempted = false;
    try {
      await client.query('begin');
      await lockImageSeriesBookLifecycle(client, request.params.bookId);
      const bookResult = await client.query(
        `select id, cover_asset_id, metadata_revision, active_content_revision_id,
                exists(select 1 from book_id_generations identity
                       where identity.user_id = $2 and identity.book_id = $1 and identity.generation > 1) as has_prior_purge
           from library_books
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
      const contentConflict = coverContentRevisionConflict(book, expectedContentRevisionId);
      if (contentConflict) {
        await client.query('rollback');
        await deleteObject(createS3Client(config), config, storageKey).catch(() => undefined);
        return contentRevisionError(reply, contentConflict);
      }
      const contentRevisionId =
        typeof book.active_content_revision_id === 'string' ? book.active_content_revision_id : undefined;
      if (book.cover_asset_id) {
        const current = (
          await client.query('select * from book_assets where id = $1 and user_id = $2 and book_id = $3 for update', [
            book.cover_asset_id,
            config.defaultUserId,
            request.params.bookId,
          ])
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
        if (requestedProvenance === 'approved_enrichment') {
          const retained = await client.query(
            `update book_assets set status = 'superseded'
               where id = $1 and user_id = $2 and book_id = $3 and kind = 'cover' and status = 'active'
               returning *`,
            [book.cover_asset_id, config.defaultUserId, request.params.bookId],
          );
          previousCover = retained.rows[0];
        } else {
          const previous = await client.query('delete from book_assets where id = $1 returning storage_key', [
            book.cover_asset_id,
          ]);
          previousKey = previous.rows[0] ? String(previous.rows[0].storage_key) : undefined;
        }
      }
      await client.query(
        `insert into book_assets
             (id, user_id, book_id, content_revision_id, kind, provenance, status, storage_key, file_name, content_type,
              byte_length, content_hash, pixel_width, pixel_height, created_at, activated_at)
           values ($1, $2, $3, $4, 'cover', $5, 'active', $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
        [
          id,
          config.defaultUserId,
          request.params.bookId,
          contentRevisionId ?? null,
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
             cover_position_y = $4, cover_removed_at = null,
             metadata_revision = metadata_revision + 1, updated_at = $5
           where id = $6 and user_id = $7
           returning metadata_revision`,
        [id, fit, positionX, positionY, now, request.params.bookId, config.defaultUserId],
      );
      metadataRevision = Number(updated.rows[0].metadata_revision);
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
           coverRemovedAt: null,
           metadataRevision,
          updatedAt: now,
        },
        contentRevisionId,
        now,
      );
      commitAttempted = true;
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      transactionFailed = true;
      transactionError = error;
    } finally {
      client.release();
    }
    if (transactionFailed) {
      if (!commitAttempted) {
        await deleteUploadedCoverIfUnreferenced(pool, config, id, storageKey);
      }
      // Once COMMIT was attempted, its outcome can be ambiguous. Retaining an
      // unreferenced object is safer than deleting bytes that a late commit may reference.
      throw transactionError;
    }
    if (previousKey) await deleteObject(createS3Client(config), config, previousKey).catch(() => undefined);
    return {
      cover: await coverRow(pool, config.defaultUserId, request.params.bookId),
      previousCover: previousCover ?? null,
      metadataRevision,
      coverRemovedAt: null,
    };
  };

  app.put<{ Params: { bookId: string }; Headers: CoverHeaders; Body: Buffer }>(
    '/api/books/:bookId/cover',
    { bodyLimit: 10 * 1024 * 1024 },
    async (request, reply) => {
      if (header(request.headers['x-cover-provenance']) === 'approved_enrichment') {
        return reply.code(400).send({ error: 'approved enrichment covers require the dedicated endpoint' });
      }
      return saveCover(request, reply);
    },
  );

  app.put<{ Params: { bookId: string }; Headers: CoverHeaders; Body: Buffer }>(
    '/api/books/:bookId/cover/approved-enrichment',
    { bodyLimit: 10 * 1024 * 1024 },
    async (request, reply) => {
      if (expectedRevision(header(request.headers['x-expected-metadata-revision'])) === undefined) {
        return reply.code(400).send({ error: 'approved enrichment cover requires an expected metadata revision' });
      }
      return saveCover(request, reply, 'approved_enrichment');
    },
  );

  app.post<{ Params: { bookId: string }; Body: ApprovedEnrichmentCoverRestoreBody }>(
    '/api/books/:bookId/cover/approved-enrichment/restore',
    async (request, reply) => {
      const body = request.body ?? {};
      const completePreviousReference = Boolean(body.previousAssetId) === Boolean(body.previousContentHash);
      if (
        !Number.isSafeInteger(body.expectedMetadataRevision) ||
        Number(body.expectedMetadataRevision) < 0 ||
        (body.expectedContentRevisionId !== undefined && !body.expectedContentRevisionId.trim()) ||
        !body.expectedActiveAssetId?.trim() ||
        !body.expectedActiveContentHash?.trim() ||
        !completePreviousReference ||
        (body.previousFit !== 'crop' && body.previousFit !== 'contain') ||
        !Number.isFinite(body.previousPositionX) ||
        Number(body.previousPositionX) < 0 ||
        Number(body.previousPositionX) > 100 ||
        !Number.isFinite(body.previousPositionY) ||
        Number(body.previousPositionY) < 0 ||
        Number(body.previousPositionY) > 100
      ) {
        return reply.code(400).send({ error: 'approved enrichment cover restore input is invalid' });
      }

      if (body.previousAssetId && body.previousContentHash) {
        const previous = (
          await pool.query(
            `select storage_key, content_hash from book_assets
             where id = $1 and user_id = $2 and book_id = $3 and kind = 'cover' and status = 'superseded'`,
            [body.previousAssetId, config.defaultUserId, request.params.bookId],
          )
        ).rows[0];
        if (!previous || previous.content_hash !== body.previousContentHash) {
          return reply.code(409).send({ error: 'previous cover is not safely restorable' });
        }
        try {
          const stored = await getObjectBuffer(createS3Client(config), config, String(previous.storage_key));
          if (integrityHash(stored.body) !== body.previousContentHash) {
            return reply.code(409).send({ error: 'previous cover integrity check failed' });
          }
        } catch {
          return reply.code(409).send({ error: 'previous cover object is unavailable' });
        }
      }

      const client = await pool.connect();
      let restoredCover: Record<string, unknown> | undefined;
      let metadataRevision: number;
      let coverRemovedAt: string | null;
      try {
        await client.query('begin');
        await lockImageSeriesBookLifecycle(client, request.params.bookId);
        const book = (
          await client.query(
            `select id, cover_asset_id, metadata_revision, active_content_revision_id,
                    exists(select 1 from book_id_generations identity
                           where identity.user_id = $2 and identity.book_id = $1 and identity.generation > 1) as has_prior_purge
             from library_books
             where id = $1 and user_id = $2 and deleted_at is null for update`,
            [request.params.bookId, config.defaultUserId],
          )
        ).rows[0];
        if (!book) {
          await client.query('rollback');
          return reply.code(404).send({ error: 'book not found' });
        }
        if (
          Number(book.metadata_revision) !== body.expectedMetadataRevision ||
          book.cover_asset_id !== body.expectedActiveAssetId
        ) {
          await client.query('rollback');
          return reply.code(409).send({ error: 'book metadata revision changed' });
        }
        const contentRevisionId =
          typeof book.active_content_revision_id === 'string' ? book.active_content_revision_id : undefined;
        const contentConflict = coverContentRevisionConflict(
          book,
          expectedContentRevision(body.expectedContentRevisionId),
        );
        if (contentConflict) {
          await client.query('rollback');
          return contentRevisionError(reply, contentConflict);
        }

        const active = (
          await client.query(
            `select * from book_assets
             where id = $1 and user_id = $2 and book_id = $3 and kind = 'cover' and status = 'active'
             for update`,
            [body.expectedActiveAssetId, config.defaultUserId, request.params.bookId],
          )
        ).rows[0];
        if (
          !active ||
          active.provenance !== 'approved_enrichment' ||
          active.content_hash !== body.expectedActiveContentHash
        ) {
          await client.query('rollback');
          return reply.code(409).send({ error: 'approved enrichment cover changed' });
        }

        if (body.previousAssetId && body.previousContentHash) {
          const previous = (
            await client.query(
              `select * from book_assets
               where id = $1 and user_id = $2 and book_id = $3 and kind = 'cover' and status = 'superseded'
               for update`,
              [body.previousAssetId, config.defaultUserId, request.params.bookId],
            )
          ).rows[0];
          if (!previous || previous.content_hash !== body.previousContentHash) {
            await client.query('rollback');
            return reply.code(409).send({ error: 'previous cover is not safely restorable' });
          }
          restoredCover = previous;
        }

        const now = new Date().toISOString();
        coverRemovedAt = restoredCover ? null : now;
        await client.query(
          `update book_assets set status = 'superseded'
           where id = $1 and user_id = $2 and book_id = $3`,
          [body.expectedActiveAssetId, config.defaultUserId, request.params.bookId],
        );
        if (restoredCover) {
          await client.query(
            `update book_assets set status = 'active', activated_at = $1
             where id = $2 and user_id = $3 and book_id = $4`,
            [now, restoredCover.id, config.defaultUserId, request.params.bookId],
          );
        }
        const updated = await client.query(
          `update library_books set cover_asset_id = $1, cover_fit = $2, cover_position_x = $3,
             cover_position_y = $4, cover_removed_at = $5,
             metadata_revision = metadata_revision + 1, updated_at = $6
           where id = $7 and user_id = $8
           returning metadata_revision`,
          [
            restoredCover?.id ?? null,
            restoredCover ? body.previousFit : 'crop',
            restoredCover ? body.previousPositionX : 50,
            restoredCover ? body.previousPositionY : 50,
            coverRemovedAt,
            now,
            request.params.bookId,
            config.defaultUserId,
          ],
        );
        metadataRevision = Number(updated.rows[0].metadata_revision);
        await emitCoverSync(
          client,
          config.defaultUserId,
          request.params.bookId,
          {
            id: request.params.bookId,
            coverAssetId: restoredCover?.id ?? null,
            coverContentHash: restoredCover?.content_hash ?? null,
            coverFit: restoredCover ? body.previousFit : 'crop',
            coverPositionX: restoredCover ? body.previousPositionX : 50,
            coverPositionY: restoredCover ? body.previousPositionY : 50,
            coverRemovedAt,
            metadataRevision,
            updatedAt: now,
          },
          contentRevisionId,
          now,
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      return {
        cover: restoredCover ? await coverRow(pool, config.defaultUserId, request.params.bookId) : null,
        metadataRevision,
        coverRemovedAt,
      };
    },
  );

  app.delete<{
    Params: { bookId: string };
    Body: { expectedRevision?: number; expectedContentRevisionId?: string };
  }>('/api/books/:bookId/cover', async (request, reply) => {
    const client = await pool.connect();
    let storageKey: string | undefined;
    let coverRemovedAt: string | undefined;
    let metadataRevision: number | undefined;
    try {
      await client.query('begin');
      await lockImageSeriesBookLifecycle(client, request.params.bookId);
      const bookResult = await client.query(
        `select id, cover_asset_id, metadata_revision, active_content_revision_id,
                  exists(select 1 from book_id_generations identity
                         where identity.user_id = $2 and identity.book_id = $1 and identity.generation > 1) as has_prior_purge
           from library_books
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
      if (request.body?.expectedContentRevisionId !== undefined && !request.body.expectedContentRevisionId.trim()) {
        await client.query('rollback');
        return reply.code(400).send({ error: 'expected content revision id is invalid' });
      }
      const contentRevisionId =
        typeof book.active_content_revision_id === 'string' ? book.active_content_revision_id : undefined;
      const contentConflict = coverContentRevisionConflict(
        book,
        expectedContentRevision(request.body?.expectedContentRevisionId),
      );
      if (contentConflict) {
        await client.query('rollback');
        return contentRevisionError(reply, contentConflict);
      }
      const now = new Date().toISOString();
      await client.query(
        `update library_books set cover_asset_id = null, cover_fit = 'crop', cover_position_x = 50,
             cover_position_y = 50, cover_removed_at = $1,
             metadata_revision = metadata_revision + 1, updated_at = $1
           where id = $2 and user_id = $3`,
        [now, request.params.bookId, config.defaultUserId],
      );
      coverRemovedAt = now;
      metadataRevision = Number(book.metadata_revision) + 1;
      if (book.cover_asset_id) {
        const removed = await client.query('delete from book_assets where id = $1 returning storage_key', [
          book.cover_asset_id,
        ]);
        storageKey = removed.rows[0] ? String(removed.rows[0].storage_key) : undefined;
      }
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
           coverRemovedAt: now,
           metadataRevision,
          updatedAt: now,
        },
        contentRevisionId,
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
    return { ok: true, coverRemovedAt, metadataRevision };
  });
}
