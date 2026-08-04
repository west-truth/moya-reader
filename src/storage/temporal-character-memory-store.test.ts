import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AddressUseEventV1 } from '../providers/speaker-attribution/address-event';
import type { CandidateMemoryViewV2 } from '../providers/speaker-attribution/candidate-memory';
import type { SourceMentionInventoryV1 } from '../providers/speaker-attribution/mention-inventory';
import { buildCharacterTemporalSnapshot } from '../providers/speaker-attribution/reader-state-snapshot';
import {
  deriveTemporalRelationEdgesFromAddressEvents,
  reconcileAddressUseEvent,
  supersedeTemporalRelationEdge,
} from '../providers/speaker-attribution/temporal-relation';
import { openReaderDb, READER_DB_VERSION, resetReaderDbForTests } from './reader-database';
import { TEMPORAL_CHARACTER_MEMORY_STORES } from './temporal-character-memory-schema';
import {
  appendTemporalAddressUseEvents,
  appendTemporalRelationEdges,
  clearTemporalCharacterMemoryRevision,
  getCharacterTemporalSnapshot,
  listTemporalAddressUseEvents,
  listTemporalRelationEdges,
  replaceCharacterTemporalSnapshotsForChapter,
} from './temporal-character-memory-store';

const bookId = 'book_1';
const contentRevisionId = 'revision_1';
const chapterId = 'chapter_1';

function observedEvent(id: string, sceneId: string, narrativeOrder: number): AddressUseEventV1 {
  return {
    version: 'address-use-event-v2',
    id,
    bookId,
    contentRevisionId,
    chapterId,
    sceneId,
    spanId: `span_${id}`,
    mentionId: `mention_${id}`,
    narrativeOrder,
    surfaceHash: `surface_${id}`,
    normalizedSurface: '선배',
    addressClass: 'organizational',
    contextType: 'direct',
    evidenceStartOffset: 0,
    evidenceEndOffset: 2,
    speakerCandidateIds: ['entity_a', 'entity_b'],
    addresseeCandidateIds: ['entity_a', 'entity_b'],
    status: 'observed',
    relationStatus: 'unresolved',
    confidenceKind: 'rule',
    confidence: 1,
    revision: `source_${id}`,
    extractionCode: 'address_term_lexicon',
    fingerprint: `fingerprint_${id}`,
  };
}

function memory(): CandidateMemoryViewV2 {
  return {
    version: 'candidate-memory-view-v6',
    id: 'memory_1',
    bookId,
    contentRevisionId,
    chapterId,
    chapterIndex: 1,
    sceneId: 'scene_2',
    entities: [
      {
        entityId: 'entity_a',
        entityKind: 'canonical_character',
        characterId: 'character_a',
        displayName: '가람',
        normalizedSurfaces: ['가람'],
        trustLevel: 'high',
        evidenceMentionIds: [],
        inclusionReasons: ['current_scene_mention'],
        localRank: 0,
        speechTraitCount: 0,
        userConfirmed: true,
      },
      {
        entityId: 'entity_b',
        entityKind: 'canonical_character',
        characterId: 'character_b',
        displayName: '보라',
        normalizedSurfaces: ['보라'],
        trustLevel: 'high',
        evidenceMentionIds: [],
        inclusionReasons: ['current_scene_mention'],
        localRank: 1,
        speechTraitCount: 0,
        userConfirmed: true,
      },
    ],
    mentionInventoryHash: 'mention_hash',
    mentionIds: [],
    addressEventIds: [],
    recentTurns: [],
    correctionIds: [],
    localCandidateViewHash: 'local_candidate_hash',
    graphKnowledgeHash: 'graph_hash',
    fingerprint: 'memory_hash',
  };
}

const mentions: SourceMentionInventoryV1 = {
  version: 'source-mention-inventory-v2',
  id: 'mentions_1',
  bookId,
  contentRevisionId,
  chapterId,
  detectorVersion: 'test',
  mentions: [],
  fingerprint: 'mention_hash',
};

describe('temporal character memory IndexedDB persistence', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('keeps event and edge revisions append-only and replaces derived snapshots by chapter', async () => {
    const first = reconcileAddressUseEvent(observedEvent('event_1', 'scene_1', 10), {
      speakerEntityId: 'entity_a',
      addresseeEntityId: 'entity_b',
      revision: 'correction_1',
    });
    const second = reconcileAddressUseEvent(observedEvent('event_2', 'scene_2', 20), {
      speakerEntityId: 'entity_a',
      addresseeEntityId: 'entity_b',
      revision: 'correction_2',
    });
    await appendTemporalAddressUseEvents([first, second]);
    await appendTemporalAddressUseEvents([first, second]);
    expect(await listTemporalAddressUseEvents(contentRevisionId)).toHaveLength(2);

    const edge = deriveTemporalRelationEdgesFromAddressEvents({
      bookId,
      contentRevisionId,
      events: [first, second],
      assertedAtRevision: 'relation_1',
    })[0]!;
    const replacement = supersedeTemporalRelationEdge(edge, {
      assertedAtRevision: 'relation_2',
      readerVisibleFromOrder: 25,
    });
    await appendTemporalRelationEdges([edge, replacement]);
    expect(await listTemporalRelationEdges(contentRevisionId)).toEqual([replacement]);
    expect(await listTemporalRelationEdges(contentRevisionId, { activeOnly: false })).toHaveLength(2);

    const snapshot = buildCharacterTemporalSnapshot({
      bookId,
      contentRevisionId,
      chapterId,
      sceneId: 'scene_2',
      narrativeOrder: 30,
      readerMode: 'reader_safe',
      candidateMemory: memory(),
      mentionInventory: mentions,
      addressEvents: [first, second],
      temporalRelationEdges: [edge, replacement],
      sourceRevision: 'source_1',
      graphRevision: 'graph_1',
    });
    await replaceCharacterTemporalSnapshotsForChapter({ contentRevisionId, chapterId, snapshots: [snapshot] });
    expect(await getCharacterTemporalSnapshot(contentRevisionId, 'scene_2', 'reader_safe')).toEqual(snapshot);

    const db = await openReaderDb();
    expect(db.version).toBe(READER_DB_VERSION);
    expect(Object.values(TEMPORAL_CHARACTER_MEMORY_STORES).every((name) => db.objectStoreNames.contains(name))).toBe(
      true,
    );
    await clearTemporalCharacterMemoryRevision(contentRevisionId);
    expect(await listTemporalAddressUseEvents(contentRevisionId)).toEqual([]);
    expect(await listTemporalRelationEdges(contentRevisionId)).toEqual([]);
    expect(await getCharacterTemporalSnapshot(contentRevisionId, 'scene_2', 'reader_safe')).toBeUndefined();
  });
});
