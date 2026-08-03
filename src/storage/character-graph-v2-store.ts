import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { Character, LabeledSegment, Novel, VoiceProfile } from '../domain/types';
import type { CharacterGraph, CharacterRelation } from '../providers/ai';
import {
  buildCharacterIdentityOperationPlanV2,
  CharacterIdentityConflictError,
} from '../providers/character-identity-operation';
import {
  backfillCharacterGraphKnowledgeV2,
  CHARACTER_GRAPH_KNOWLEDGE_VERSION,
  deriveCharacterMergeCandidatesV2,
  type CharacterGraphKnowledgeV2,
  type CharacterIdentityCommandV2,
  type CharacterIdentityOperationResultV2,
} from '../providers/character-graph-v2';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';
import { jsonValue, queueSyncEventInTransaction } from './sync-event-store';
import { CHARACTER_GRAPH_V2_STORES } from './character-graph-v2-schema';
import type { RevisionChapterRow } from './content-revision-store';

interface StoredCharacterIdentityReceiptV2 extends CharacterIdentityOperationResultV2 {
  readonly id: string;
  readonly novelId: string;
  readonly commandHash: string;
  readonly appliedAt: string;
}

const KNOWLEDGE_STORES = [
  CHARACTER_GRAPH_V2_STORES.facts,
  CHARACTER_GRAPH_V2_STORES.mentions,
  CHARACTER_GRAPH_V2_STORES.addressTerms,
  CHARACTER_GRAPH_V2_STORES.speechTraits,
  CHARACTER_GRAPH_V2_STORES.relationFacts,
  CHARACTER_GRAPH_V2_STORES.evidence,
  CHARACTER_GRAPH_V2_STORES.mergeCandidates,
  CHARACTER_GRAPH_V2_STORES.redirects,
] as const;

const OPERATION_STORES = [
  ...KNOWLEDGE_STORES,
  CHARACTER_GRAPH_V2_STORES.receipts,
  'characters',
  'character_relations',
  'segments',
  'voice_profiles',
  'chapters',
  'novels',
  'book_content_chapters',
  'devices',
  'sync_outbox',
  'sync_state',
] as const;

function rowsByStore(
  knowledge: CharacterGraphKnowledgeV2,
): Record<(typeof KNOWLEDGE_STORES)[number], readonly { id: string }[]> {
  return {
    [CHARACTER_GRAPH_V2_STORES.facts]: knowledge.facts,
    [CHARACTER_GRAPH_V2_STORES.mentions]: knowledge.mentions,
    [CHARACTER_GRAPH_V2_STORES.addressTerms]: knowledge.addressTerms,
    [CHARACTER_GRAPH_V2_STORES.speechTraits]: knowledge.speechTraits,
    [CHARACTER_GRAPH_V2_STORES.relationFacts]: knowledge.relationFacts,
    [CHARACTER_GRAPH_V2_STORES.evidence]: knowledge.evidence,
    [CHARACTER_GRAPH_V2_STORES.mergeCandidates]: knowledge.mergeCandidates,
    [CHARACTER_GRAPH_V2_STORES.redirects]: knowledge.redirects,
  };
}

async function knowledgeFromTransaction(tx: IDBTransaction, novelId: string): Promise<CharacterGraphKnowledgeV2> {
  const [facts, mentions, addressTerms, speechTraits, relationFacts, evidence, mergeCandidates, redirects] =
    await Promise.all(
      KNOWLEDGE_STORES.map((name) =>
        requestToPromise<unknown[]>(tx.objectStore(name).index('novelId').getAll(novelId)),
      ),
    );
  const knowledge: CharacterGraphKnowledgeV2 = {
    version: CHARACTER_GRAPH_KNOWLEDGE_VERSION,
    novelId,
    facts: facts as CharacterGraphKnowledgeV2['facts'],
    mentions: mentions as CharacterGraphKnowledgeV2['mentions'],
    addressTerms: addressTerms as CharacterGraphKnowledgeV2['addressTerms'],
    speechTraits: speechTraits as CharacterGraphKnowledgeV2['speechTraits'],
    relationFacts: relationFacts as CharacterGraphKnowledgeV2['relationFacts'],
    evidence: evidence as CharacterGraphKnowledgeV2['evidence'],
    mergeCandidates: mergeCandidates as CharacterGraphKnowledgeV2['mergeCandidates'],
    redirects: redirects as CharacterGraphKnowledgeV2['redirects'],
  };
  return { ...knowledge, mergeCandidates: deriveCharacterMergeCandidatesV2(knowledge) };
}

async function replaceKnowledgeInTransaction(
  tx: IDBTransaction,
  current: CharacterGraphKnowledgeV2,
  next: CharacterGraphKnowledgeV2,
): Promise<void> {
  const currentRows = rowsByStore(current);
  const nextRows = rowsByStore(next);
  for (const name of KNOWLEDGE_STORES) {
    const store = tx.objectStore(name);
    const nextIds = new Set(nextRows[name].map((row) => row.id));
    for (const row of currentRows[name]) if (!nextIds.has(row.id)) store.delete(row.id);
    for (const row of nextRows[name]) store.put(row);
  }
}

function knowledgeIsEmpty(knowledge: CharacterGraphKnowledgeV2): boolean {
  return KNOWLEDGE_STORES.every((name) => rowsByStore(knowledge)[name].length === 0);
}

async function saveBackfill(knowledge: CharacterGraphKnowledgeV2): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction([...KNOWLEDGE_STORES], 'readwrite');
  for (const [name, rows] of Object.entries(rowsByStore(knowledge))) {
    const store = tx.objectStore(name);
    for (const row of rows) store.put(row);
  }
  await transactionDone(tx);
}

export async function getCharacterGraphKnowledgeV2(novelId: string): Promise<CharacterGraphKnowledgeV2> {
  const db = await openReaderDb();
  const tx = db.transaction([...KNOWLEDGE_STORES, 'characters', 'character_relations'], 'readonly');
  const [knowledge, characters, relations] = await Promise.all([
    knowledgeFromTransaction(tx, novelId),
    requestToPromise<Character[]>(tx.objectStore('characters').index('novelId').getAll(novelId)),
    requestToPromise<CharacterRelation[]>(tx.objectStore('character_relations').index('novelId').getAll(novelId)),
  ]);
  await transactionDone(tx);
  if (!knowledgeIsEmpty(knowledge) || (characters.length === 0 && relations.length === 0)) return knowledge;
  const backfill = backfillCharacterGraphKnowledgeV2({ novelId, characters, relations });
  await saveBackfill(backfill);
  return backfill;
}

export async function saveCharacterGraphObservationsV2(observations: CharacterGraphKnowledgeV2): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction([...KNOWLEDGE_STORES], 'readwrite');
  const current = await knowledgeFromTransaction(tx, observations.novelId);
  const merge = <T extends { id: string }>(left: readonly T[], right: readonly T[]) => [
    ...new Map([...left, ...right].map((row) => [row.id, row])).values(),
  ];
  const next: CharacterGraphKnowledgeV2 = {
    version: CHARACTER_GRAPH_KNOWLEDGE_VERSION,
    novelId: observations.novelId,
    facts: merge(current.facts, observations.facts),
    mentions: merge(current.mentions, observations.mentions),
    addressTerms: merge(current.addressTerms, observations.addressTerms),
    speechTraits: merge(current.speechTraits, observations.speechTraits),
    relationFacts: merge(current.relationFacts, observations.relationFacts),
    evidence: merge(current.evidence, observations.evidence),
    mergeCandidates: merge(current.mergeCandidates, observations.mergeCandidates),
    redirects: merge(current.redirects, observations.redirects),
  };
  await replaceKnowledgeInTransaction(tx, current, {
    ...next,
    mergeCandidates: deriveCharacterMergeCandidatesV2(next),
  });
  await transactionDone(tx);
}

function sameRows(left: readonly unknown[], right: readonly unknown[]): boolean {
  return structuredIntegrityHash(left) === structuredIntegrityHash(right);
}

export async function applyLocalCharacterIdentityCommandV2(
  command: CharacterIdentityCommandV2,
): Promise<CharacterIdentityOperationResultV2> {
  const db = await openReaderDb();
  const tx = db.transaction([...OPERATION_STORES], 'readwrite');
  const done = transactionDone(tx);
  try {
    const receiptStore = tx.objectStore(CHARACTER_GRAPH_V2_STORES.receipts);
    const existingReceipt = await requestToPromise<StoredCharacterIdentityReceiptV2 | undefined>(
      receiptStore.get(command.operationId),
    );
    const commandHash = structuredIntegrityHash(command);
    if (existingReceipt) {
      if (existingReceipt.commandHash !== commandHash) {
        throw new CharacterIdentityConflictError('Character identity operation id was reused', 'operation_reused');
      }
      await done;
      const { id: _id, novelId: _novelId, commandHash: _hash, appliedAt: _appliedAt, ...result } = existingReceipt;
      return result;
    }
    const [characters, relations, knowledge, segments, voiceProfiles, novel, revisionChapters] = await Promise.all([
      requestToPromise<Character[]>(tx.objectStore('characters').index('novelId').getAll(command.novelId)),
      requestToPromise<CharacterRelation[]>(
        tx.objectStore('character_relations').index('novelId').getAll(command.novelId),
      ),
      knowledgeFromTransaction(tx, command.novelId),
      requestToPromise<LabeledSegment[]>(tx.objectStore('segments').index('novelId').getAll(command.novelId)),
      requestToPromise<VoiceProfile[]>(tx.objectStore('voice_profiles').index('novelId').getAll(command.novelId)),
      requestToPromise<Novel | undefined>(tx.objectStore('novels').get(command.novelId)),
      requestToPromise<RevisionChapterRow[]>(
        tx.objectStore('book_content_chapters').index('novelId').getAll(command.novelId),
      ),
    ]);
    const graph: CharacterGraph = { novelId: command.novelId, characters, relations };
    const activeKnowledge = knowledgeIsEmpty(knowledge) ? backfillCharacterGraphKnowledgeV2(graph) : knowledge;
    const plan = buildCharacterIdentityOperationPlanV2({
      command,
      graph,
      knowledge: activeKnowledge,
      segments,
      voiceProfiles,
      chapterIndexById: Object.fromEntries(
        revisionChapters
          .filter(
            (chapter) => !novel?.activeContentRevisionId || chapter.contentRevisionId === novel.activeContentRevisionId,
          )
          .map((chapter) => [chapter.id, chapter.index]),
      ),
    });

    const characterStore = tx.objectStore('characters');
    const relationStore = tx.objectStore('character_relations');
    const finalCharacterIds = new Set(plan.graph.characters.map((item) => item.id));
    const finalRelationIds = new Set(plan.graph.relations.map((item) => item.id));
    for (const character of characters) if (!finalCharacterIds.has(character.id)) characterStore.delete(character.id);
    for (const relation of relations) if (!finalRelationIds.has(relation.id)) relationStore.delete(relation.id);
    for (const character of plan.graph.characters) characterStore.put(character);
    for (const relation of plan.graph.relations) relationStore.put(relation);
    await replaceKnowledgeInTransaction(tx, activeKnowledge, plan.knowledge);

    if (!sameRows(segments, plan.segments)) {
      const segmentStore = tx.objectStore('segments');
      for (const segment of plan.segments) segmentStore.put(segment);
    }
    if (!sameRows(voiceProfiles, plan.voiceProfiles)) {
      const voiceStore = tx.objectStore('voice_profiles');
      const nextIds = new Set(plan.voiceProfiles.map((profile) => profile.id));
      for (const profile of voiceProfiles) if (!nextIds.has(profile.id)) voiceStore.delete(profile.id);
      for (const profile of plan.voiceProfiles) voiceStore.put(profile);
    }

    const syncItems = [
      await queueSyncEventInTransaction(
        tx,
        'character_graph_updated',
        jsonValue({ mode: 'replace', characters: plan.graph.characters, relations: plan.graph.relations }),
        { novelId: command.novelId, entityId: `character_graph_${command.novelId}` },
      ),
    ];
    const changedChapterIds = new Set(
      plan.segments.filter((segment, index) => segment !== segments[index]).map((segment) => segment.chapterId),
    );
    for (const chapterId of changedChapterIds) {
      syncItems.push(
        await queueSyncEventInTransaction(
          tx,
          'chapter_segments_updated',
          jsonValue({
            compoundOperationId: command.operationId,
            chapterId,
            segments: plan.segments.filter((segment) => segment.chapterId === chapterId),
          }),
          { novelId: command.novelId, entityId: `chapter_segments_${chapterId}` },
        ),
      );
    }
    if (!sameRows(voiceProfiles, plan.voiceProfiles)) {
      syncItems.push(
        await queueSyncEventInTransaction(
          tx,
          'voice_profiles_updated',
          jsonValue({ voiceProfiles: plan.voiceProfiles }),
          { novelId: command.novelId, entityId: `voice_profiles_${command.novelId}` },
        ),
      );
    }
    receiptStore.put({
      id: command.operationId,
      novelId: command.novelId,
      commandHash: plan.commandHash,
      appliedAt: command.createdAt,
      ...plan.result,
    } satisfies StoredCharacterIdentityReceiptV2);
    await done;
    return plan.result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // Transaction may already be complete.
    }
    await done.catch(() => undefined);
    throw error;
  }
}
