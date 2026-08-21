import { persistentId128 } from '@noveldesk/text-core/hash';
import type { ReaderPageBoundary } from '../domain/types';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';
import { READER_PAGE_MAP_STORE } from './reader-page-map-schema';

export interface ReaderPageMapIdentity {
  readonly chapterId: string;
  readonly contentRevisionId: string;
  readonly layoutKey: string;
  readonly rendererVersion: string;
}

export interface StoredReaderPageMap extends ReaderPageMapIdentity {
  readonly id: string;
  readonly boundaries: readonly ReaderPageBoundary[];
  readonly createdAt: string;
  readonly lastAccessedAt: string;
}

export function readerPageMapId(identity: ReaderPageMapIdentity): string {
  return persistentId128('reader_page_map', [
    identity.contentRevisionId,
    identity.chapterId,
    identity.layoutKey,
    identity.rendererVersion,
  ]);
}

export async function loadReaderPageMap(
  identity: ReaderPageMapIdentity,
  now = new Date().toISOString(),
): Promise<StoredReaderPageMap | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(READER_PAGE_MAP_STORE, 'readwrite');
  const store = tx.objectStore(READER_PAGE_MAP_STORE);
  const record = await requestToPromise<StoredReaderPageMap | undefined>(store.get(readerPageMapId(identity)));
  if (!record) {
    await transactionDone(tx);
    return undefined;
  }
  const touched = { ...record, lastAccessedAt: now };
  store.put(touched);
  await transactionDone(tx);
  return touched;
}

export async function saveReaderPageMap(
  identity: ReaderPageMapIdentity,
  boundaries: readonly ReaderPageBoundary[],
  now = new Date().toISOString(),
): Promise<StoredReaderPageMap> {
  const db = await openReaderDb();
  const tx = db.transaction(READER_PAGE_MAP_STORE, 'readwrite');
  const store = tx.objectStore(READER_PAGE_MAP_STORE);
  const id = readerPageMapId(identity);
  const previous = await requestToPromise<StoredReaderPageMap | undefined>(store.get(id));
  const record: StoredReaderPageMap = {
    ...identity,
    id,
    boundaries,
    createdAt: previous?.createdAt ?? now,
    lastAccessedAt: now,
  };
  store.put(record);
  await transactionDone(tx);
  return record;
}

export async function pruneReaderPageMaps(maxLayouts = 24): Promise<number> {
  const db = await openReaderDb();
  const tx = db.transaction(READER_PAGE_MAP_STORE, 'readwrite');
  const store = tx.objectStore(READER_PAGE_MAP_STORE);
  const records = await requestToPromise<StoredReaderPageMap[]>(store.getAll());
  const remove = records
    .sort((left, right) => right.lastAccessedAt.localeCompare(left.lastAccessedAt))
    .slice(Math.max(0, Math.floor(maxLayouts)));
  remove.forEach((record) => store.delete(record.id));
  await transactionDone(tx);
  return remove.length;
}
