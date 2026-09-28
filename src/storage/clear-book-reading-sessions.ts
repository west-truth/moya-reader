import type { ReadingSessionEvent } from '../domain/types';
import { requestToPromise } from './indexeddb-transaction';

/** Listening has its own resume/history controls; a reading reset only clears reading sessions. */
export async function clearBookReadingSessions(tx: IDBTransaction, bookId: string): Promise<void> {
  const store = tx.objectStore('reading_session_events');
  const rows = await requestToPromise<ReadingSessionEvent[]>(store.index('bookId').getAll(bookId));
  for (const row of rows) if (row.mode === 'reading') store.delete(row.id);
}
