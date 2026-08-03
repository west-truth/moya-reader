import type { AddressUseEventV1 } from '../providers/speaker-attribution/address-event';
import type { CharacterTemporalSnapshotV1 } from '../providers/speaker-attribution/reader-state-snapshot';
import {
  activeAddressUseEvents,
  activeTemporalRelationEdges,
} from '../providers/speaker-attribution/temporal-relation-state';
import type { TemporalRelationEdgeV1 } from '../providers/speaker-attribution/temporal-relation';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';
import { TEMPORAL_CHARACTER_MEMORY_STORES } from './temporal-character-memory-schema';

type AppendOnlyRow = { readonly id: string; readonly fingerprint: string };

async function appendRows<T extends AppendOnlyRow>(storeName: string, rows: readonly T[]): Promise<void> {
  if (rows.length === 0) return;
  const uniqueRows = [...new Map(rows.map((row) => [row.id, row])).values()];
  const db = await openReaderDb();
  const tx = db.transaction(storeName, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(storeName);
  const existing = await Promise.all(uniqueRows.map((row) => requestToPromise<T | undefined>(store.get(row.id))));
  uniqueRows.forEach((row, index) => {
    const previous = existing[index];
    if (previous && previous.fingerprint !== row.fingerprint) {
      tx.abort();
      throw new Error(`Append-only temporal row ${row.id} conflicts with persisted content`);
    }
    if (!previous) store.add(row);
  });
  await done;
}

export function appendTemporalAddressUseEvents(events: readonly AddressUseEventV1[]): Promise<void> {
  return appendRows(TEMPORAL_CHARACTER_MEMORY_STORES.addressEvents, events);
}

export function appendTemporalRelationEdges(edges: readonly TemporalRelationEdgeV1[]): Promise<void> {
  return appendRows(TEMPORAL_CHARACTER_MEMORY_STORES.relationEdges, edges);
}

export async function listTemporalAddressUseEvents(
  contentRevisionId: string,
  options?: { readonly activeOnly?: boolean },
): Promise<AddressUseEventV1[]> {
  const db = await openReaderDb();
  const tx = db.transaction(TEMPORAL_CHARACTER_MEMORY_STORES.addressEvents, 'readonly');
  const done = transactionDone(tx);
  const events = await requestToPromise<AddressUseEventV1[]>(
    tx.objectStore(TEMPORAL_CHARACTER_MEMORY_STORES.addressEvents).index('contentRevisionId').getAll(contentRevisionId),
  );
  await done;
  return options?.activeOnly === false ? events : [...activeAddressUseEvents(events)];
}

export async function listTemporalRelationEdges(
  contentRevisionId: string,
  options?: { readonly activeOnly?: boolean },
): Promise<TemporalRelationEdgeV1[]> {
  const db = await openReaderDb();
  const tx = db.transaction(TEMPORAL_CHARACTER_MEMORY_STORES.relationEdges, 'readonly');
  const done = transactionDone(tx);
  const edges = await requestToPromise<TemporalRelationEdgeV1[]>(
    tx.objectStore(TEMPORAL_CHARACTER_MEMORY_STORES.relationEdges).index('contentRevisionId').getAll(contentRevisionId),
  );
  await done;
  return options?.activeOnly === false ? edges : [...activeTemporalRelationEdges(edges)];
}

export async function replaceCharacterTemporalSnapshotsForChapter(input: {
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly snapshots: readonly CharacterTemporalSnapshotV1[];
}): Promise<void> {
  if (
    input.snapshots.some(
      (snapshot) => snapshot.contentRevisionId !== input.contentRevisionId || snapshot.chapterId !== input.chapterId,
    )
  ) {
    throw new Error('Temporal snapshot replacement contains a different source revision or chapter');
  }
  const db = await openReaderDb();
  const tx = db.transaction(TEMPORAL_CHARACTER_MEMORY_STORES.snapshots, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(TEMPORAL_CHARACTER_MEMORY_STORES.snapshots);
  const keys = await requestToPromise<IDBValidKey[]>(
    store.index('contentRevisionId_chapterId').getAllKeys([input.contentRevisionId, input.chapterId]),
  );
  keys.forEach((key) => store.delete(key));
  input.snapshots.forEach((snapshot) => store.put(snapshot));
  await done;
}

export async function getCharacterTemporalSnapshot(
  contentRevisionId: string,
  sceneId: string,
  readerMode: CharacterTemporalSnapshotV1['readerMode'],
): Promise<CharacterTemporalSnapshotV1 | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(TEMPORAL_CHARACTER_MEMORY_STORES.snapshots, 'readonly');
  const done = transactionDone(tx);
  const snapshot = await requestToPromise<CharacterTemporalSnapshotV1 | undefined>(
    tx
      .objectStore(TEMPORAL_CHARACTER_MEMORY_STORES.snapshots)
      .index('contentRevisionId_sceneId_mode')
      .get([contentRevisionId, sceneId, readerMode]),
  );
  await done;
  return snapshot;
}

export async function clearTemporalCharacterMemoryRevision(contentRevisionId: string): Promise<void> {
  const storeNames = Object.values(TEMPORAL_CHARACTER_MEMORY_STORES);
  const db = await openReaderDb();
  const tx = db.transaction(storeNames, 'readwrite');
  const done = transactionDone(tx);
  const keysByStore = await Promise.all(
    storeNames.map((name) =>
      requestToPromise<IDBValidKey[]>(tx.objectStore(name).index('contentRevisionId').getAllKeys(contentRevisionId)),
    ),
  );
  storeNames.forEach((name, index) => {
    keysByStore[index]!.forEach((key) => tx.objectStore(name).delete(key));
  });
  await done;
}
