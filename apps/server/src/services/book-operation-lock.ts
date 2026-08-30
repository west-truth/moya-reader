export const IMAGE_SERIES_BOOK_LOCK_NAMESPACE = 7319;

export interface BookOperationLockQuery {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Shares the incremental image-series import lock with lifecycle mutations.
 * A completed purge therefore wins over an already running append, while an
 * append that starts later observes that the canonical book no longer exists.
 */
export async function lockImageSeriesBookLifecycle(queryable: BookOperationLockQuery, bookId: string): Promise<void> {
  await queryable.query('select pg_advisory_xact_lock(hashtextextended($1, $2))', [
    bookId,
    IMAGE_SERIES_BOOK_LOCK_NAMESPACE,
  ]);
}

export function isBookLifecycleEvent(type: string): boolean {
  return (
    type === 'book_updated' ||
    type === 'book_trashed' ||
    type === 'book_restored' ||
    type === 'book_purged' ||
    type === 'book_deleted'
  );
}
