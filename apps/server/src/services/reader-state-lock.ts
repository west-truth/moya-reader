import type pg from 'pg';

const READER_STATE_LOCK_NAMESPACE = 8843;

/**
 * Serializes all server-side mutations of one user's reading position and
 * exact fixed-document section markers. Direct reader APIs and sync ingestion
 * must use the same lock before checking timestamps or tombstones.
 */
export async function lockReaderState(client: pg.PoolClient, userId: string, bookId: string): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, $2))', [
    `${userId}:${bookId}`,
    READER_STATE_LOCK_NAMESPACE,
  ]);
}

export function isReadingPositionEvent(type: string): boolean {
  return type === 'reading_position_updated' || type === 'reading_position_deleted';
}
