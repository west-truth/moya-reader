import { textIntegrityHash } from '@noveldesk/text-core/hash';
import type { SpeakerSourceParagraphInput } from '@noveldesk/text-core/speaker-attribution';
import { describe, expect, it } from 'vitest';
import type { Character } from '../../domain/types';
import { backfillCharacterGraphKnowledgeV2 } from '../character-graph-v2';
import type { AddressUseEventV1 } from './address-event';
import { expandSpeakerAttributionToCanonicalLabels } from './canonical-expander';
import type { CandidateMemoryViewV2 } from './candidate-memory';
import { SpeakerReviewBits, type SceneSpeakerPacketV3, type SpeakerWireV2 } from './contracts';
import { runDeterministicSpeakerSieve } from './deterministic-sieve';
import { buildSpeakerAttributionChapter } from './inventory-builder';
import type { SourceMentionInventoryV1 } from './mention-inventory';
import { parseSpeakerWireV2Json } from './parser';
import { buildCharacterTemporalSnapshot, TEMPORAL_SNAPSHOT_CONFLICT } from './reader-state-snapshot';
import { buildCompactSpeakerAttributionRequest } from './request-profile';
import { compileSpeakerWireV2Schema } from './schema-compiler';
import { buildSceneSpeakerPacket } from './scene-packet';
import { decodeDialogueSequences } from './sequence-decoder';
import { buildTemporalInvalidationPlan, temporalSceneDependency } from './temporal-invalidation';
import { deriveTemporalRelationEdgesFromAddressEvents, supersedeTemporalRelationEdge } from './temporal-relation';
import { validateSpeakerWireV2 } from './validator';

const bookId = 'book_1';
const contentRevisionId = 'revision_1';
const chapterId = 'chapter_1';

function addressEvent(
  id: string,
  sceneId: string,
  narrativeOrder: number,
  patch: Partial<AddressUseEventV1> = {},
): AddressUseEventV1 {
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
    surfaceHash: `hash_${id}`,
    normalizedSurface: '여보',
    addressClass: 'romantic',
    contextType: 'direct',
    evidenceStartOffset: 0,
    evidenceEndOffset: 2,
    speakerCandidateIds: ['entity_a'],
    addresseeCandidateIds: ['entity_b'],
    status: 'reconciled',
    relationStatus: 'candidate',
    confidenceKind: 'calibrated',
    confidence: 0.95,
    revision: `revision_${id}`,
    extractionCode: 'address_term_lexicon',
    fingerprint: `fingerprint_${id}`,
    ...patch,
  };
}

function candidateMemory(): CandidateMemoryViewV2 {
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

function emptyMentionInventory(): SourceMentionInventoryV1 {
  return {
    version: 'source-mention-inventory-v2',
    id: 'mention_inventory_1',
    bookId,
    contentRevisionId,
    chapterId,
    detectorVersion: 'test',
    mentions: [],
    fingerprint: 'mention_hash',
  };
}

describe('temporal relation and reader-state snapshot', () => {
  it('requires independent observations and blocks future and unknown-flashback leakage', () => {
    const single = deriveTemporalRelationEdgesFromAddressEvents({
      bookId,
      contentRevisionId,
      events: [addressEvent('one', 'scene_1', 10)],
      assertedAtRevision: 'relation_revision_1',
    });
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({ status: 'provisional', relationType: 'address:romantic' });
    expect(single[0]!.relationType).not.toContain('spouse');

    const edges = deriveTemporalRelationEdgesFromAddressEvents({
      bookId,
      contentRevisionId,
      events: [
        addressEvent('one', 'scene_1', 10),
        addressEvent('two', 'scene_2', 20),
        addressEvent('roleplay', 'scene_3', 30, { contextType: 'roleplay' }),
      ],
      assertedAtRevision: 'relation_revision_2',
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ status: 'confirmed', readerVisibleFromOrder: 20 });

    const common = {
      bookId,
      contentRevisionId,
      chapterId,
      candidateMemory: candidateMemory(),
      candidateEntityIds: ['entity_a', 'entity_b'],
      mentionInventory: emptyMentionInventory(),
      addressEvents: [],
      temporalRelationEdges: edges,
      sourceRevision: 'source_revision_1',
      graphRevision: 'graph_revision_1',
      readerMode: 'reader_safe' as const,
    };
    const beforeReveal = buildCharacterTemporalSnapshot({
      ...common,
      sceneId: 'scene_early',
      narrativeOrder: 15,
    });
    const afterReveal = buildCharacterTemporalSnapshot({
      ...common,
      sceneId: 'scene_after',
      narrativeOrder: 25,
    });
    const flashback = buildCharacterTemporalSnapshot({
      ...common,
      sceneId: 'scene_flashback',
      narrativeOrder: 30,
      isFlashback: true,
    });
    expect(beforeReveal.relationEdges).toEqual([]);
    expect(beforeReveal.conflictCodes).toContain(TEMPORAL_SNAPSHOT_CONFLICT.futureRelationExcluded);
    expect(afterReveal.relationEdges).toHaveLength(1);
    expect(flashback.relationEdges).toEqual([]);
    expect(flashback.conflictCodes).toContain(TEMPORAL_SNAPSHOT_CONFLICT.storyTimeUnsafe);
    expect(buildCharacterTemporalSnapshot({ ...common, sceneId: 'scene_after', narrativeOrder: 25 }).fingerprint).toBe(
      afterReveal.fingerprint,
    );
  });

  it('invalidates only scenes whose visible relation projection changed', () => {
    const before = deriveTemporalRelationEdgesFromAddressEvents({
      bookId,
      contentRevisionId,
      events: [addressEvent('one', 'scene_1', 10), addressEvent('two', 'scene_2', 20)],
      assertedAtRevision: 'relation_revision_2',
    })[0]!;
    const after = supersedeTemporalRelationEdge(before, {
      assertedAtRevision: 'relation_revision_3',
      readerVisibleFromOrder: 30,
    });
    const scenes = [10, 20, 25, 30, 40].map((narrativeOrder) =>
      temporalSceneDependency({
        sceneId: `scene_${narrativeOrder}`,
        chapterId,
        narrativeOrder,
        candidateEntityIds: ['entity_a', 'entity_b'],
        snapshotId: `snapshot_${narrativeOrder}`,
        dialogueBurstIds: [`burst_${narrativeOrder}`],
      }),
    );
    scenes.push(
      temporalSceneDependency({
        sceneId: 'scene_unrelated',
        chapterId,
        narrativeOrder: 25,
        candidateEntityIds: ['entity_a'],
        snapshotId: 'snapshot_unrelated',
        dialogueBurstIds: ['burst_unrelated'],
      }),
    );
    const plan = buildTemporalInvalidationPlan({ bookId, contentRevisionId, before, after, scenes });
    expect(plan.reason).toBe('relation_interval_changed');
    expect(plan.sceneIds).toEqual(['scene_20', 'scene_25']);
    expect(plan.dialogueBurstIds).toEqual(['burst_20', 'burst_25']);
  });
});

function character(id: string, name: string): Character {
  return {
    id,
    novelId: bookId,
    canonicalName: name,
    aliases: [],
    color: '#336699',
    confidence: 0.95,
    isUserConfirmed: true,
  };
}

function sourceParagraphs(texts: readonly string[]): SpeakerSourceParagraphInput[] {
  let offset = 0;
  return texts.map((text, paragraphIndex) => {
    const startOffsetInChapter = offset;
    offset += text.length + 2;
    return {
      paragraphId: `paragraph_${paragraphIndex}`,
      chapterId,
      paragraphIndex,
      text,
      textHash: textIntegrityHash(text),
      startOffsetInChapter,
      endOffsetInChapter: startOffsetInChapter + text.length,
    };
  });
}

function buildCompactFixture() {
  const characters = [
    character('character_a', '가람'),
    character('character_b', '보라'),
    character('character_c', '초희'),
  ];
  const paragraphs = sourceParagraphs(['“안녕.”', '“그래.”', '“또 봐.”']);
  const built = buildSpeakerAttributionChapter({
    bookId,
    contentRevisionId,
    chapterId,
    chapterIndex: 1,
    paragraphs,
    characters,
    graphKnowledge: backfillCharacterGraphKnowledgeV2({ novelId: bookId, characters, relations: [] }),
    recentTurns: characters.map((item, index) => ({
      paragraphId: `recent_${index}`,
      speakerId: item.id,
      listenerIds: [],
      emotion: 'neutral',
      text: `recent turn ${index}`,
    })),
  });
  const sceneId = built.inventory.sceneInventory.scenes[0]!.id;
  const memory = built.candidateMemories[sceneId]!;
  const snapshot = buildCharacterTemporalSnapshot({
    bookId,
    contentRevisionId,
    chapterId,
    sceneId,
    narrativeOrder: 1_000_000,
    readerMode: 'reader_safe',
    candidateMemory: memory,
    mentionInventory: built.inventory.mentionInventory,
    addressEvents: built.inventory.addressEvents,
    temporalRelationEdges: [],
    sourceRevision: 'source_revision_1',
    graphRevision: 'graph_revision_1',
  });
  const sieve = runDeterministicSpeakerSieve({
    spanInventory: built.inventory.spanInventory,
    paragraphs,
    mentionInventory: built.inventory.mentionInventory,
    candidateSelections: built.candidateSelections,
    candidateMemories: built.candidateMemories,
  });
  const packet = buildSceneSpeakerPacket({
    bookId,
    contentRevisionId,
    chapterId,
    sceneId,
    sourceRevision: 'source_revision_1',
    sourceManifestFingerprint: 'manifest_hash',
    spanInventory: built.inventory.spanInventory,
    mentionInventory: built.inventory.mentionInventory,
    dialogueBurstInventory: built.inventory.dialogueBurstInventory,
    candidateMemory: memory,
    candidateSelections: built.candidateSelections,
    temporalSnapshot: snapshot,
    sieve,
    paragraphs,
  });
  return { characters, paragraphs, built, memory, sieve, packet };
}

describe('compact speaker resolver', () => {
  it('builds a request-derived provider profile without leaking internal options', () => {
    const { packet } = buildCompactFixture();
    const request = buildCompactSpeakerAttributionRequest({
      packet,
      providerId: 'gemini-ai-studio',
      modelId: 'gemini-3.1-flash-lite',
      providerOptions: { requestProfileId: 'speaker-attribution-v3-compact', temperature: 0.1 },
    });
    expect(request.outputBudget.decision).toBe('accepted');
    expect(request.providerOptions).toMatchObject({ temperature: 0.1 });
    expect(request.providerOptions).not.toHaveProperty('requestProfileId');
    expect(request.responseSchema).not.toHaveProperty('$schema');
    expect(request.responseSchema).toMatchObject({ type: 'OBJECT' });

    const serializedGeminiSchema = JSON.stringify(request.responseSchema);
    for (const unsupportedKeyword of ['const', 'additionalProperties', 'prefixItems']) {
      expect(serializedGeminiSchema).not.toContain(`"${unsupportedKeyword}"`);
    }
    expect(serializedGeminiSchema).not.toContain('"items":false');

    const exactJsonSchema = compileSpeakerWireV2Schema(packet);
    expect(exactJsonSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        v: { const: 2 },
        f: { const: packet.fingerprint },
        x: { items: { items: false } },
      },
    });
    expect(JSON.stringify(exactJsonSchema)).toContain('"prefixItems"');
  });

  it('compiles exact dynamic schemas for N=1/5/20/40', () => {
    const { packet } = buildCompactFixture();
    for (const count of [1, 5, 20, 40]) {
      const fixture: SceneSpeakerPacketV3 = {
        ...packet,
        targets: Array.from({ length: count }, (_, index) => [index, 0, 1, `text_${index}`, [4], [0]] as const),
      };
      const schema = compileSpeakerWireV2Schema(fixture) as {
        properties: Record<string, { minItems?: number; maxItems?: number }>;
      };
      expect(schema.properties.s).toMatchObject({ minItems: count, maxItems: count });
      expect(schema.properties.q).toMatchObject({ minItems: count, maxItems: count });
      expect(schema.properties.e).toMatchObject({ minItems: count, maxItems: count });
      expect(schema.properties.u.maxItems).toBe(count);
    }
  });

  it('forbids Gemini new-mention mappings when the packet has no grounded new mentions', () => {
    const { packet } = buildCompactFixture();
    const withoutNewMentions: SceneSpeakerPacketV3 = {
      ...packet,
      newMentionOrdinalsByTarget: [],
    };
    const schema = compileSpeakerWireV2Schema(withoutNewMentions, 'gemini') as {
      properties: Record<string, { maxItems?: number; items?: { enum?: number[] } }>;
    };

    expect(schema.properties.x.maxItems).toBe(0);
    expect(schema.properties.s.items).not.toHaveProperty('enum');
  });

  it('validates compact output, avoids rigid three-party alternation, and expands neutral canonical labels', () => {
    const { characters, paragraphs, built, memory, sieve, packet } = buildCompactFixture();
    expect(packet.targets).toHaveLength(3);
    expect(packet.dialogueBursts[0]![2]).toHaveLength(3);
    const wire: SpeakerWireV2 = {
      v: 2,
      f: packet.fingerprint,
      s: [4, 4, 5],
      q: [900, 900, 900],
      e: [1, 1, 1],
      u: [],
      c: [],
      r: [],
      x: [],
    };
    const validated = validateSpeakerWireV2(packet, wire);
    const sequence = decodeDialogueSequences(packet, validated);
    expect(sequence[0]!.selectedSpeakerOrdinals).toEqual([4, 4, 5]);
    const speakerIdByEntityId = Object.fromEntries(
      memory.entities.flatMap((entity) => (entity.characterId ? [[entity.entityId, entity.characterId]] : [])),
    );
    const expanded = expandSpeakerAttributionToCanonicalLabels({
      bookId,
      chapterId,
      characters,
      spanInventory: built.inventory.spanInventory,
      paragraphs,
      packet,
      validatedWire: validated,
      sequenceDecisions: sequence,
      sieve,
      speakerIdByEntityId,
    });
    const speakerByOrdinal = new Map(
      packet.candidates.map(([ordinal, entityId]) => [ordinal, speakerIdByEntityId[entityId]]),
    );
    expect(expanded.result.segments.map((segment) => segment.speakerId)).toEqual([
      speakerByOrdinal.get(4),
      speakerByOrdinal.get(4),
      speakerByOrdinal.get(5),
    ]);
    expect(expanded.result.segments.every((segment) => segment.emotion === 'neutral')).toBe(true);
    expect(expanded.result.segments.every((segment) => segment.prosodyIntent === undefined)).toBe(true);
  });

  it('does not reinterpret a candidate-pool union as two-party alternation', () => {
    const { packet, built, paragraphs, characters, memory, sieve } = buildCompactFixture();
    const twoParty: SceneSpeakerPacketV3 = {
      ...packet,
      candidates: packet.candidates.slice(0, 2),
      targets: packet.targets.slice(0, 2).map((target) => [target[0], target[1], target[2], target[3], [4, 5], [0, 0]]),
      dialogueBursts: [[0, packet.targets.slice(0, 2).map((target) => target[0]), [4, 5]]],
    };
    const wire: SpeakerWireV2 = {
      v: 2,
      f: twoParty.fingerprint,
      s: [4, 4],
      q: [800, 800],
      e: [0, 0],
      u: [1],
      c: [[5]],
      r: [SpeakerReviewBits.multipleCandidates],
      x: [],
    };
    const decoded = decodeDialogueSequences(twoParty, validateSpeakerWireV2(twoParty, wire));
    expect(decoded[0]!.selectedSpeakerOrdinals).toEqual([4, 4]);
    expect(decoded[0]!.disagreementIndexes).toEqual([]);
    const expanded = expandSpeakerAttributionToCanonicalLabels({
      bookId,
      chapterId,
      characters,
      spanInventory: built.inventory.spanInventory,
      paragraphs,
      packet: twoParty,
      validatedWire: validateSpeakerWireV2(twoParty, wire),
      sequenceDecisions: decoded,
      sieve,
      speakerIdByEntityId: Object.fromEntries(
        memory.entities.flatMap((entity) => (entity.characterId ? [[entity.entityId, entity.characterId]] : [])),
      ),
    });
    expect(expanded.result.uncertainties).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ reasonCode: 'speaker_sequence_disagreement' })]),
    );
    expect(expanded.result.segments[1]?.speakerId).toBe(
      Object.fromEntries(
        memory.entities.flatMap((entity) => (entity.characterId ? [[entity.entityId, entity.characterId]] : [])),
      )[twoParty.candidates.find(([ordinal]) => ordinal === 4)![1]],
    );
  });

  it('rejects malformed or ungrounded wire output', () => {
    const { packet } = buildCompactFixture();
    expect(() => parseSpeakerWireV2Json('```json\n{}\n```')).toThrow(/plain JSON/);
    expect(() =>
      parseSpeakerWireV2Json(
        JSON.stringify({ v: 2, f: 'x', s: [], q: [], e: [], u: [], c: [], r: [], x: [], extra: 1 }),
      ),
    ).toThrow(/additional/);
    const base: SpeakerWireV2 = {
      v: 2,
      f: packet.fingerprint,
      s: [4, 4, 4],
      q: [900, 900, 900],
      e: [0, 0, 0],
      u: [],
      c: [],
      r: [],
      x: [],
    };
    expect(() => validateSpeakerWireV2(packet, { ...base, f: 'wrong' })).toThrow(/fingerprint_mismatch/);
    expect(() => validateSpeakerWireV2(packet, { ...base, s: [99, 4, 4] })).toThrow(/ungrounded_speaker/);
    expect(() => validateSpeakerWireV2(packet, { ...base, q: [900] })).toThrow(/target_count_mismatch/);
    const futureCandidatePacket: SceneSpeakerPacketV3 = {
      ...packet,
      candidateSourceAnchors: [
        [4, 'future_mention', packet.sceneId, 'future_paragraph', 99, 'future_span', packet.targets[0]![0] + 1, 0, 3],
      ],
    };
    expect(() => validateSpeakerWireV2(futureCandidatePacket, base)).toThrow(/candidate_before_first_evidence/);
    const withNewMention: SceneSpeakerPacketV3 = {
      ...packet,
      mentions: [[0, '새 인물', 0]],
      mentionSourceIds: [[0, 'source_mention_1']],
      newMentionOrdinalsByTarget: [[0, [0]]],
    };
    const newAlternative: SpeakerWireV2 = {
      ...base,
      u: [0],
      c: [[3]],
      r: [SpeakerReviewBits.newEntity],
      x: [[0, 0]],
    };
    expect(() => validateSpeakerWireV2(withNewMention, newAlternative)).not.toThrow();
    expect(() => validateSpeakerWireV2(withNewMention, { ...newAlternative, x: [] })).toThrow(
      /new_entity_mapping_missing/,
    );
    expect(() => validateSpeakerWireV2(withNewMention, { ...base, x: [[0, 0]] })).not.toThrow();
    expect(() =>
      validateSpeakerWireV2(withNewMention, {
        ...base,
        x: [
          [0, 0],
          [0, 0],
        ],
      }),
    ).toThrow(/duplicate_new_entity_target/);
    expect(() => validateSpeakerWireV2(withNewMention, { ...base, x: [[0, 99]] })).toThrow(
      /ungrounded_new_entity_mention/,
    );
  });
});
