import { integrityHash, persistentIdVersion } from '../../domain/id-hash-contract';
import type { Novel } from '../../domain/types';
import type { SyncOutboxItem } from '../../sync/types';
import type { IdV2BookSource, IdV2SourceRecord } from './contracts';
import { readAll, readOne, recordKey, requestToPromise, transactionDone, yieldToMainThread } from './indexeddb';

const INDEXED_BOOK_STORES = [
  'book_content_revisions',
  'book_content_chapters',
  'book_content_paragraphs',
  'book_content_paragraph_pages',
  'book_content_paragraph_search',
  'book_content_domain_heads',
  'chapters',
  'paragraphs',
  'paragraph_pages',
  'paragraph_search',
  'bookmarks',
  'highlights',
  'notes',
  'segments',
  'characters',
  'character_relations',
  'voice_profiles',
  'corrections',
  'reading_positions',
  'sync_tombstones',
] as const;

const STORAGE_ID_STORES = new Set([
  'book_content_chapters',
  'book_content_paragraphs',
  'book_content_paragraph_pages',
  'book_content_paragraph_search',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nestedNovelId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = value.novelId ?? value.bookId;
  if (typeof direct === 'string') return direct;
  for (const nested of Object.values(value)) {
    const found = nestedNovelId(nested);
    if (found) return found;
  }
  return undefined;
}

function outboxBelongsToNovel(item: SyncOutboxItem, novelId: string): boolean {
  return (
    item.event.novelId === novelId ||
    item.event.revision?.novelId === novelId ||
    nestedNovelId(item.event.payload) === novelId
  );
}

function sourceRecord(storeName: string, value: Record<string, unknown>): IdV2SourceRecord {
  return {
    storeName,
    recordKey: recordKey(value, STORAGE_ID_STORES.has(storeName) ? 'storageId' : 'id'),
    value,
  };
}

export async function listLegacyV1Novels(db: IDBDatabase): Promise<Novel[]> {
  const novels = await readAll<Novel>(db, 'novels');
  return novels
    .filter((novel) => persistentIdVersion(novel.id) === 'v1-fnv32' && novel.id.startsWith('novel_'))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function loadIdV2BookSource(db: IDBDatabase, oldNovelId: string): Promise<IdV2BookSource | undefined> {
  const novel = await readOne<Novel>(db, 'novels', oldNovelId);
  if (!novel) return undefined;

  const records: IdV2SourceRecord[] = [sourceRecord('novels', novel as unknown as Record<string, unknown>)];
  const tx = db.transaction([...INDEXED_BOOK_STORES, 'sync_outbox'], 'readonly');
  const done = transactionDone(tx);
  const indexedValuesPromise = Promise.all(
    INDEXED_BOOK_STORES.map((storeName) =>
      requestToPromise<Record<string, unknown>[]>(
        tx.objectStore(storeName).index('novelId').getAll(IDBKeyRange.only(oldNovelId)),
      ),
    ),
  );
  const outboxPromise = requestToPromise<SyncOutboxItem[]>(tx.objectStore('sync_outbox').getAll());
  const [indexedValues, outbox] = await Promise.all([indexedValuesPromise, outboxPromise]);
  await done;
  indexedValues.forEach((values, index) => {
    const storeName = INDEXED_BOOK_STORES[index];
    values.forEach((value) => records.push(sourceRecord(storeName, value)));
  });
  outbox
    .filter((item) => outboxBelongsToNovel(item, oldNovelId))
    .forEach((item) => records.push(sourceRecord('sync_outbox', item as unknown as Record<string, unknown>)));

  records.sort(
    (left, right) => left.storeName.localeCompare(right.storeName) || left.recordKey.localeCompare(right.recordKey),
  );
  await yieldToMainThread();
  return { novel, records };
}

export function idV2SourceFingerprint(source: IdV2BookSource): string {
  const summaries = source.records.map(({ storeName, recordKey, value }) => [
    storeName,
    recordKey,
    value.updatedAt ?? value.createdAt ?? '',
    value.textHash ?? value.normalizedTextHash ?? value.rawTextHash ?? value.payloadHash ?? '',
    Array.isArray(value.paragraphs) ? value.paragraphs.length : '',
  ]);
  return integrityHash(JSON.stringify(summaries));
}
