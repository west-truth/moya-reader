import type { Novel } from '../domain/types';
import { CONTENT_REVISION_STORES } from './content-revision-migration';
import type { BookContentRevisionRecord } from './content-revisions';
import { requestToPromise } from './indexeddb-transaction';

/**
 * Returns the server-issued revision token represented by a local physical
 * content revision. Local revision IDs are device-specific and must never be
 * sent to, or compared with, a hosted server CAS token.
 */
export async function canonicalRemoteContentRevisionId(
  transaction: IDBTransaction,
  novel: Pick<Novel, 'activeContentRevisionId'>,
): Promise<string | undefined> {
  if (!novel.activeContentRevisionId) return undefined;
  const revision = await requestToPromise<BookContentRevisionRecord | undefined>(
    transaction.objectStore(CONTENT_REVISION_STORES.revisions).get(novel.activeContentRevisionId),
  );
  return revision?.sourceRevision?.trim() || undefined;
}
