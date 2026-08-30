import type pg from 'pg';
import { lockImageSeriesBookLifecycle } from './book-operation-lock.js';
import { enqueueObjectDeletions } from './object-delete-outbox.js';

export interface HostedBookPurgeExpectation {
  readonly metadataRevision?: number;
  readonly contentRevisionId?: string;
  readonly requireTrashed?: boolean;
  readonly rejectTokenlessReusedId?: boolean;
}

export type HostedBookPurgeResult =
  | {
      readonly status: 'purged';
      readonly bookId: string;
      readonly metadataRevision: number;
      readonly contentRevisionId: string;
    }
  | { readonly status: 'missing' | 'conflict' | 'not_trashed' };

/**
 * Canonical hosted hard-delete boundary. The book row is locked before every
 * object key is enumerated, so FK-backed writers cannot add a reference that
 * escapes the durable object-deletion outbox.
 */
export async function purgeHostedBook(
  client: pg.PoolClient,
  userId: string,
  bookId: string,
  expectation: HostedBookPurgeExpectation = {},
): Promise<HostedBookPurgeResult> {
  await lockImageSeriesBookLifecycle(client, bookId);
  const selected = await client.query<{
    object_id: string | null;
    metadata_revision: number;
    active_content_revision_id: string;
    deleted_at: Date | string | null;
  }>(
    `select object_id, metadata_revision, active_content_revision_id, deleted_at
       from library_books
      where id = $1 and user_id = $2
      for update`,
    [bookId, userId],
  );
  const book = selected.rows[0];
  if (!book) return { status: 'missing' };
  if (expectation.requireTrashed !== false && !book.deleted_at) return { status: 'not_trashed' };
  if (expectation.metadataRevision !== undefined && Number(book.metadata_revision) !== expectation.metadataRevision) {
    return { status: 'conflict' };
  }
  if (
    expectation.contentRevisionId !== undefined &&
    String(book.active_content_revision_id) !== expectation.contentRevisionId
  ) {
    return { status: 'conflict' };
  }
  if (expectation.rejectTokenlessReusedId && !expectation.contentRevisionId) {
    const priorPurge = await client.query(
      `select 1 from book_id_generations
        where user_id = $1 and book_id = $2 and generation > 1
        limit 1`,
      [userId, bookId],
    );
    if (priorPurge.rows[0]) return { status: 'conflict' };
  }

  const referencedObjects = await client.query<{ storage_key: string }>(
    `select storage_key from book_assets where book_id = $1 and user_id = $2
     union
     select audio_object_key as storage_key from tts_audio_cache where book_id = $1
     union
     select raw_response_object_key as storage_key
       from analysis_review_artifacts
      where book_id = $1 and user_id = $2 and raw_response_object_key is not null`,
    [bookId, userId],
  );
  const storageKeys = referencedObjects.rows.map((row) => String(row.storage_key));
  const deleted = await client.query<{
    object_id: string | null;
    metadata_revision: number;
    active_content_revision_id: string;
  }>(
    `delete from library_books
      where id = $1 and user_id = $2
      returning object_id, metadata_revision, active_content_revision_id`,
    [bookId, userId],
  );
  if (!deleted.rows[0]) throw new Error('locked book disappeared before hosted purge');

  if (book.object_id) {
    const source = await client.query<{ storage_key: string }>(
      `delete from book_objects source
        where source.id = $1
          and not exists (select 1 from library_books book where book.object_id = source.id)
        returning source.storage_key`,
      [book.object_id],
    );
    if (source.rows[0]) storageKeys.push(String(source.rows[0].storage_key));
  }
  await enqueueObjectDeletions(client, storageKeys, 'purged_book');
  return {
    status: 'purged',
    bookId,
    metadataRevision: Number(book.metadata_revision),
    contentRevisionId: String(book.active_content_revision_id),
  };
}
