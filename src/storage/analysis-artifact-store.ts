import type { Character, LabeledSegment, UserCorrection, VoiceProfile } from '../domain/types';
import type { CharacterRelation } from '../providers/ai';
import {
  assertResourceRevision,
  chapterSegmentsRevision,
  characterGraphRevision,
  correctionRevision,
  voiceProfilesRevision,
  type ResourceMutationOptions,
} from '../domain/resource-revisions';
import { getAllByIndex, requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';
import { getChapter } from './reader-query-store';
import { providerOptionsContainSecretLikeValue } from './provider-options-secret-guard';
import { jsonValue, nowIso, queueSyncEventInTransaction, tombstoneEntity, tombstoneId } from './sync-event-store';

function replaceByIndexInTransaction<T extends { id: string }>(
  tx: IDBTransaction,
  storeName: 'segments' | 'characters' | 'voice_profiles',
  indexName: 'chapterId' | 'novelId',
  query: IDBValidKey | IDBKeyRange,
  items: T[],
): Promise<void> {
  const store = tx.objectStore(storeName);
  const request = store.index(indexName).openKeyCursor(query);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      try {
        tx.abort();
      } catch {
        // The transaction may already have aborted because of the failed write.
      }
      reject(error);
    };
    request.onerror = () => fail(request.error);
    tx.addEventListener('abort', () => fail(tx.error ?? new DOMException('Transaction aborted', 'AbortError')), {
      once: true,
    });
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
          return;
        }
        for (const item of items) store.put(item);
        settled = true;
        resolve();
      } catch (error) {
        fail(error);
      }
    };
  });
}

async function removeOrphanedRelations(tx: IDBTransaction, novelId: string, characterIds: Set<string>): Promise<void> {
  const store = tx.objectStore('character_relations');
  const relations = await requestToPromise<CharacterRelation[]>(store.index('novelId').getAll(novelId));
  for (const relation of relations) {
    if (!characterIds.has(relation.sourceCharacterId) || !characterIds.has(relation.targetCharacterId)) {
      store.delete(relation.id);
    }
  }
}

export async function getSegments(chapterId: string): Promise<LabeledSegment[]> {
  const segments = await getAllByIndex<LabeledSegment>('segments', 'chapterId', chapterId);
  return segments.sort((a, b) => a.segmentIndex - b.segmentIndex);
}

export async function saveSegments(
  chapterId: string,
  segments: LabeledSegment[],
  options?: ResourceMutationOptions,
): Promise<void> {
  const novelId = segments[0]?.novelId || (await getChapter(chapterId))?.novelId;
  const chapterSegments = segments.map((segment) => ({ ...segment, chapterId }));
  const payload = novelId
    ? jsonValue({
        chapterId,
        segments: chapterSegments.map((segment) => ({ ...segment, novelId })),
      })
    : undefined;
  const db = await openReaderDb();
  const tx = db.transaction(['segments', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const current = await requestToPromise<LabeledSegment[]>(
    tx.objectStore('segments').index('chapterId').getAll(chapterId),
  );
  if (options) assertResourceRevision('chapter_segments', options.expectedRevision, chapterSegmentsRevision(current));
  const writes: Promise<unknown>[] = [
    replaceByIndexInTransaction(tx, 'segments', 'chapterId', chapterId, chapterSegments),
  ];
  if (novelId && payload) {
    writes.push(
      queueSyncEventInTransaction(tx, 'chapter_segments_updated', payload, {
        novelId,
        entityId: `chapter_segments_${chapterId}`,
      }),
    );
  }
  await Promise.all(writes);
  await transactionDone(tx);
}

export async function getCharacters(novelId: string): Promise<Character[]> {
  return getAllByIndex<Character>('characters', 'novelId', novelId);
}

export async function saveCharacters(
  novelId: string,
  characters: Character[],
  options?: ResourceMutationOptions,
): Promise<void> {
  const graphCharacters = characters.map((character) => ({ ...character, novelId }));
  const payload = jsonValue({ mode: 'replace', characters: graphCharacters });
  const db = await openReaderDb();
  const tx = db.transaction(['characters', 'character_relations', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const [currentCharacters, currentRelations] = await Promise.all([
    requestToPromise<Character[]>(tx.objectStore('characters').index('novelId').getAll(novelId)),
    requestToPromise<CharacterRelation[]>(tx.objectStore('character_relations').index('novelId').getAll(novelId)),
  ]);
  if (options) {
    assertResourceRevision(
      'character_graph',
      options.expectedRevision,
      characterGraphRevision(currentCharacters, currentRelations),
    );
  }
  const characterIds = new Set(graphCharacters.map((character) => character.id));
  await Promise.all([
    replaceByIndexInTransaction(tx, 'characters', 'novelId', novelId, graphCharacters),
    removeOrphanedRelations(tx, novelId, characterIds),
    queueSyncEventInTransaction(tx, 'character_graph_updated', payload, {
      novelId,
      entityId: `character_graph_${novelId}`,
    }),
  ]);
  await transactionDone(tx);
}

export async function saveCharacterGraph(
  novelId: string,
  graph: { characters: Character[]; relations: CharacterRelation[] },
  options?: ResourceMutationOptions,
): Promise<void> {
  const graphCharacters = graph.characters.map((character) => ({ ...character, novelId }));
  const graphRelations = graph.relations.map((relation) => ({ ...relation, novelId }));
  const db = await openReaderDb();
  const tx = db.transaction(['characters', 'character_relations', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const characterStore = tx.objectStore('characters');
  const relationStore = tx.objectStore('character_relations');
  const [existingCharacters, existingRelations] = await Promise.all([
    requestToPromise<Character[]>(characterStore.index('novelId').getAll(novelId)),
    requestToPromise<CharacterRelation[]>(relationStore.index('novelId').getAll(novelId)),
  ]);
  if (options) {
    assertResourceRevision(
      'character_graph',
      options.expectedRevision,
      characterGraphRevision(existingCharacters, existingRelations),
    );
  }
  for (const character of existingCharacters) characterStore.delete(character.id);
  for (const relation of existingRelations) relationStore.delete(relation.id);
  for (const character of graphCharacters) characterStore.put(character);
  for (const relation of graphRelations) relationStore.put(relation);
  await queueSyncEventInTransaction(
    tx,
    'character_graph_updated',
    jsonValue({ mode: 'replace', characters: graphCharacters, relations: graphRelations }),
    { novelId, entityId: `character_graph_${novelId}` },
  );
  await transactionDone(tx);
}

export async function getCharacterRelations(novelId: string): Promise<CharacterRelation[]> {
  return getAllByIndex<CharacterRelation>('character_relations', 'novelId', novelId);
}

export async function getVoiceProfiles(novelId: string): Promise<VoiceProfile[]> {
  const profiles = await getAllByIndex<VoiceProfile>('voice_profiles', 'novelId', novelId);
  return profiles.sort((a, b) => {
    const roleOrder = ['narrator', 'character', 'system', 'unknown'];
    const roleDiff = roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role);
    if (roleDiff) return roleDiff;
    return a.label.localeCompare(b.label);
  });
}

export async function saveVoiceProfiles(
  novelId: string,
  voiceProfiles: VoiceProfile[],
  options?: ResourceMutationOptions,
): Promise<void> {
  const timestamp = nowIso();
  const profiles = voiceProfiles.map((profile) => ({
    ...profile,
    novelId,
    createdAt: profile.createdAt ?? timestamp,
    updatedAt: timestamp,
  }));
  if (profiles.some((profile) => providerOptionsContainSecretLikeValue(profile.providerOptions))) {
    throw new Error('voice profile providerOptions must not contain secret-like keys or values');
  }
  const payload = jsonValue({ voiceProfiles: profiles });
  const db = await openReaderDb();
  const tx = db.transaction(['voice_profiles', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const current = await requestToPromise<VoiceProfile[]>(
    tx.objectStore('voice_profiles').index('novelId').getAll(novelId),
  );
  if (options) assertResourceRevision('voice_profiles', options.expectedRevision, voiceProfilesRevision(current));
  await Promise.all([
    replaceByIndexInTransaction(tx, 'voice_profiles', 'novelId', novelId, profiles),
    queueSyncEventInTransaction(tx, 'voice_profiles_updated', payload, {
      novelId,
      entityId: `voice_profiles_${novelId}`,
    }),
  ]);
  await transactionDone(tx);
}

export async function getCorrections(novelId: string): Promise<UserCorrection[]> {
  const corrections = await getAllByIndex<UserCorrection>('corrections', 'novelId', novelId);
  return corrections.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveCorrection(correction: UserCorrection, options?: ResourceMutationOptions): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(['corrections', 'sync_tombstones', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const current = await requestToPromise<UserCorrection | undefined>(tx.objectStore('corrections').get(correction.id));
  if (options) assertResourceRevision('user_correction', options.expectedRevision, correctionRevision(current));
  tx.objectStore('sync_tombstones').delete(tombstoneId('user_correction', correction.id));
  tx.objectStore('corrections').put(correction);
  await queueSyncEventInTransaction(tx, 'user_correction_created', jsonValue({ correction }), {
    novelId: correction.novelId,
    entityId: correction.id,
  });
  await transactionDone(tx);
}

export async function deleteCorrection(novelId: string, id: string, options?: ResourceMutationOptions): Promise<void> {
  const deletedAt = nowIso();
  const db = await openReaderDb();
  const tx = db.transaction(['corrections', 'sync_tombstones', 'devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const correction = await requestToPromise<UserCorrection | undefined>(tx.objectStore('corrections').get(id));
  if (options) assertResourceRevision('user_correction', options.expectedRevision, correctionRevision(correction));
  const eventNovelId = correction?.novelId ?? novelId;
  tx.objectStore('corrections').delete(id);
  tx.objectStore('sync_tombstones').put(tombstoneEntity('user_correction', id, deletedAt, eventNovelId));
  await queueSyncEventInTransaction(tx, 'user_correction_deleted', jsonValue({ id, correction, deletedAt }), {
    novelId: eventNovelId,
    entityId: id,
  });
  await transactionDone(tx);
}
