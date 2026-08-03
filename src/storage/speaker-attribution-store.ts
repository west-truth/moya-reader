import type {
  DialogueBurstV1,
  SpeakerSceneV1,
  SpeakerSourceManifestV1,
  SpeakerSpanV1,
} from '@noveldesk/text-core/speaker-attribution';
import type { AddressUseEventV1 } from '../providers/speaker-attribution/address-event';
import {
  reassembleSpeakerAttributionChapterInventory,
  speakerAttributionChapterInventoryMeta,
  type SpeakerAttributionChapterInventoryMetaV1,
  type SpeakerAttributionChapterInventoryV1,
} from '../providers/speaker-attribution/chapter-inventory';
import type { SpeakerEntityV1 } from '../providers/speaker-attribution/identity-policy';
import type { SourceMentionV1 } from '../providers/speaker-attribution/mention-inventory';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';
import { SPEAKER_ATTRIBUTION_STORES } from './speaker-attribution-schema';

const CHAPTER_DERIVED_STORES = [
  SPEAKER_ATTRIBUTION_STORES.chapterInventories,
  SPEAKER_ATTRIBUTION_STORES.scenes,
  SPEAKER_ATTRIBUTION_STORES.spans,
  SPEAKER_ATTRIBUTION_STORES.dialogueBursts,
  SPEAKER_ATTRIBUTION_STORES.mentions,
  SPEAKER_ATTRIBUTION_STORES.entities,
  SPEAKER_ATTRIBUTION_STORES.addressEvents,
] as const;

function chapterKey(contentRevisionId: string, chapterId: string): IDBKeyRange {
  return IDBKeyRange.only([contentRevisionId, chapterId]);
}

function deleteKeys(store: IDBObjectStore, keys: readonly IDBValidKey[]): void {
  for (const key of keys) store.delete(key);
}

export async function putSpeakerSourceManifest(manifest: SpeakerSourceManifestV1): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(SPEAKER_ATTRIBUTION_STORES.manifests, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(SPEAKER_ATTRIBUTION_STORES.manifests);
  const staleKeys = await requestToPromise<IDBValidKey[]>(
    store.index('contentRevisionId').getAllKeys(manifest.contentRevisionId),
  );
  deleteKeys(store, staleKeys);
  store.put(manifest);
  await done;
}

export async function getSpeakerSourceManifest(
  contentRevisionId: string,
): Promise<SpeakerSourceManifestV1 | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(SPEAKER_ATTRIBUTION_STORES.manifests, 'readonly');
  const done = transactionDone(tx);
  const manifest = await requestToPromise<SpeakerSourceManifestV1 | undefined>(
    tx.objectStore(SPEAKER_ATTRIBUTION_STORES.manifests).index('contentRevisionId').get(contentRevisionId),
  );
  await done;
  return manifest;
}

export async function replaceSpeakerAttributionChapterInventory(
  inventory: SpeakerAttributionChapterInventoryV1,
): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction([...CHAPTER_DERIVED_STORES], 'readwrite');
  const done = transactionDone(tx);
  const key = chapterKey(inventory.contentRevisionId, inventory.chapterId);
  const requests = CHAPTER_DERIVED_STORES.map((name) =>
    tx.objectStore(name).index('contentRevisionId_chapterId').getAllKeys(key),
  );
  const staleKeysByStore = await Promise.all(requests.map((request) => requestToPromise<IDBValidKey[]>(request)));
  CHAPTER_DERIVED_STORES.forEach((name, index) => {
    deleteKeys(tx.objectStore(name), staleKeysByStore[index]!);
  });

  tx.objectStore(SPEAKER_ATTRIBUTION_STORES.chapterInventories).put(speakerAttributionChapterInventoryMeta(inventory));
  const rows: ReadonlyArray<readonly [string, readonly { readonly id: string }[]]> = [
    [SPEAKER_ATTRIBUTION_STORES.scenes, inventory.sceneInventory.scenes],
    [SPEAKER_ATTRIBUTION_STORES.spans, inventory.spanInventory.spans],
    [SPEAKER_ATTRIBUTION_STORES.dialogueBursts, inventory.dialogueBurstInventory.bursts],
    [SPEAKER_ATTRIBUTION_STORES.mentions, inventory.mentionInventory.mentions],
    [SPEAKER_ATTRIBUTION_STORES.entities, inventory.entities],
    [SPEAKER_ATTRIBUTION_STORES.addressEvents, inventory.addressEvents],
  ];
  for (const [name, values] of rows) {
    const store = tx.objectStore(name);
    for (const value of values) store.put(value);
  }
  await done;
}

export async function getSpeakerAttributionChapterInventory(
  contentRevisionId: string,
  chapterId: string,
): Promise<SpeakerAttributionChapterInventoryV1 | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction([...CHAPTER_DERIVED_STORES], 'readonly');
  const done = transactionDone(tx);
  const key = chapterKey(contentRevisionId, chapterId);
  const [meta, scenes, spans, dialogueBursts, mentions, entities, addressEvents] = await Promise.all([
    requestToPromise<SpeakerAttributionChapterInventoryMetaV1 | undefined>(
      tx
        .objectStore(SPEAKER_ATTRIBUTION_STORES.chapterInventories)
        .index('contentRevisionId_chapterId_unique')
        .get(key),
    ),
    requestToPromise<SpeakerSceneV1[]>(
      tx.objectStore(SPEAKER_ATTRIBUTION_STORES.scenes).index('contentRevisionId_chapterId').getAll(key),
    ),
    requestToPromise<SpeakerSpanV1[]>(
      tx.objectStore(SPEAKER_ATTRIBUTION_STORES.spans).index('contentRevisionId_chapterId').getAll(key),
    ),
    requestToPromise<DialogueBurstV1[]>(
      tx.objectStore(SPEAKER_ATTRIBUTION_STORES.dialogueBursts).index('contentRevisionId_chapterId').getAll(key),
    ),
    requestToPromise<SourceMentionV1[]>(
      tx.objectStore(SPEAKER_ATTRIBUTION_STORES.mentions).index('contentRevisionId_chapterId').getAll(key),
    ),
    requestToPromise<SpeakerEntityV1[]>(
      tx.objectStore(SPEAKER_ATTRIBUTION_STORES.entities).index('contentRevisionId_chapterId').getAll(key),
    ),
    requestToPromise<AddressUseEventV1[]>(
      tx.objectStore(SPEAKER_ATTRIBUTION_STORES.addressEvents).index('contentRevisionId_chapterId').getAll(key),
    ),
  ]);
  await done;
  if (!meta) return undefined;
  return reassembleSpeakerAttributionChapterInventory({
    meta,
    scenes,
    spans,
    dialogueBursts,
    mentions,
    entities,
    addressEvents,
  });
}

export async function listSpeakerEntitiesForRevision(contentRevisionId: string): Promise<SpeakerEntityV1[]> {
  const db = await openReaderDb();
  const tx = db.transaction(SPEAKER_ATTRIBUTION_STORES.entities, 'readonly');
  const done = transactionDone(tx);
  const entities = await requestToPromise<SpeakerEntityV1[]>(
    tx.objectStore(SPEAKER_ATTRIBUTION_STORES.entities).index('contentRevisionId').getAll(contentRevisionId),
  );
  await done;
  return entities.sort((left, right) => left.id.localeCompare(right.id));
}

export async function clearSpeakerAttributionRevision(contentRevisionId: string): Promise<void> {
  const storeNames = [SPEAKER_ATTRIBUTION_STORES.manifests, ...CHAPTER_DERIVED_STORES] as const;
  const db = await openReaderDb();
  const tx = db.transaction([...storeNames], 'readwrite');
  const done = transactionDone(tx);
  const requests = storeNames.map((name) =>
    tx.objectStore(name).index('contentRevisionId').getAllKeys(contentRevisionId),
  );
  const keysByStore = await Promise.all(requests.map((request) => requestToPromise<IDBValidKey[]>(request)));
  storeNames.forEach((name, index) => deleteKeys(tx.objectStore(name), keysByStore[index]!));
  await done;
}
