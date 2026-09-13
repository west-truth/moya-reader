import { createHash } from 'node:crypto';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type pg from 'pg';
import type { ServerConfig } from '../config.js';
import type { ImportExpectedBase } from '../../../../src/services/import/import-service.js';

export type ReadDocumentSeriesSnapshot = (
  bookId: string,
  expected: ImportExpectedBase,
  signal: AbortSignal,
) => Promise<{
  existingSource?: { blob: Blob; contentType?: string };
  sourceContentHash?: string;
}>;

/** Reads only the owner's immutable original, fenced again by the normal import worker. */
export function createDocumentSeriesSnapshot(
  pool: pg.Pool,
  config: ServerConfig,
  s3: S3Client,
): ReadDocumentSeriesSnapshot {
  return async (bookId, expected, signal) => {
    signal.throwIfAborted();
    const read = async () =>
      (
        await pool.query<{
          active_content_revision_id: string;
          format: string;
          deleted_at: unknown;
          storage_key: string;
          raw_text_hash: string;
          size_bytes: string;
          content_type: string;
        }>(
          `select b.active_content_revision_id, b.format, b.deleted_at,
        o.storage_key, o.raw_text_hash, o.size_bytes, o.content_type
        from library_books b left join book_objects o on o.id = b.object_id
        where b.id = $1 and b.user_id = $2`,
          [bookId, config.defaultUserId],
        )
      ).rows[0];
    const before = await read();
    if (expected.kind === 'absent') {
      if (before) throw new Error('import_expected_base_conflict');
      return {};
    }
    if (!before || before.deleted_at || before.active_content_revision_id !== expected.contentRevisionId)
      throw new Error('import_expected_base_conflict');
    const size = Number(before.size_bytes);
    if (
      before.format !== 'txt' ||
      !before.storage_key ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > config.maxUploadBytes
    )
      throw new Error('invalid_source_assets');
    const object = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: before.storage_key }), {
      abortSignal: signal,
    });
    const body = object.Body;
    if (!body || !(Symbol.asyncIterator in body)) throw new Error('invalid_source_assets');
    const chunks: Uint8Array[] = [];
    let length = 0;
    const hash = createHash('sha256');
    try {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        signal.throwIfAborted();
        length += chunk.byteLength;
        if (length > size) throw new Error('source_body_limit');
        hash.update(chunk);
        chunks.push(chunk);
      }
    } finally {
      if ('destroy' in body && typeof body.destroy === 'function') body.destroy();
    }
    signal.throwIfAborted();
    const sourceContentHash = `sha256:${hash.digest('hex')}`;
    if (
      length !== size ||
      sourceContentHash.replace('sha256:', '') !== before.raw_text_hash.replace(/^sha256:/, '').toLowerCase()
    )
      throw new Error('invalid_source_assets');
    const after = await read();
    if (
      !after ||
      after.deleted_at ||
      after.active_content_revision_id !== before.active_content_revision_id ||
      after.raw_text_hash !== before.raw_text_hash
    )
      throw new Error('import_expected_base_conflict');
    return {
      existingSource: {
        blob: new Blob(chunks as BlobPart[], { type: before.content_type }),
        contentType: before.content_type,
      },
      sourceContentHash,
    };
  };
}
