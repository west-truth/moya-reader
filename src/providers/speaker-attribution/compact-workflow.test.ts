import { describe, expect, it } from 'vitest';
import { resolveLLMGenerationPolicy } from '../provider-generation-policy';
import type { SceneSpeakerPacketV3, ValidatedSpeakerWireV2 } from './contracts';
import type { DeterministicSpeakerSieveResultV1 } from './deterministic-sieve';
import { estimateSpeakerOutputBudget } from './output-budget';
import {
  assessSpeakerEscalationTargetRisks,
  compareIndependentSpeakerEscalation,
  routeSpeakerRisks,
  selectBoundedSpeakerEscalationTargets,
  selectIndependentEscalationTargets,
} from './routing';
import { sliceSceneSpeakerPacketTargets } from './scene-packet';
import { decodeDialogueSequences } from './sequence-decoder';
import {
  assertSpeakerAttributionPinnedPayload,
  SPEAKER_ATTRIBUTION_WORKFLOW_CONTRACT_VERSION,
  type SpeakerAttributionPinnedPayloadV3,
} from './workflow-contract';

function packetFixture(): SceneSpeakerPacketV3 {
  return {
    version: 6,
    contract: 'scene-speaker-packet-v6',
    fingerprint: 'packet_full',
    bookId: 'book_1',
    contentRevisionId: 'revision_1',
    chapterId: 'chapter_1',
    sceneId: 'scene_1',
    sourceRevision: 'source_revision_1',
    sourceManifestFingerprint: 'source_manifest_hash',
    spanInventoryHash: 'span_inventory_hash',
    mentionInventoryHash: 'mention_inventory_hash',
    candidateMemoryHash: 'candidate_memory_hash',
    temporalSnapshotId: 'temporal_snapshot_1',
    temporalSnapshotHash: 'temporal_snapshot_hash',
    dialogueBurstInventoryHash: 'dialogue_burst_inventory_hash',
    sieveVersion: 'deterministic-speaker-sieve-v2',
    correctionCursor: 'none',
    mode: 'reader_safe',
    candidates: [
      [4, 'entity_a', 'A', 1],
      [5, 'entity_b', 'B', 2],
    ],
    candidateSourceAnchors: [],
    mentions: [
      [0, 'A', 0],
      [1, 'visitor', 3],
    ],
    mentionSourceIds: [
      [0, 'mention_a'],
      [1, 'mention_visitor'],
    ],
    newMentionOrdinalsByTarget: [
      [1, [0]],
      [3, [1]],
      [4, [0, 1]],
    ],
    recentTurns: [],
    relationDictionary: [],
    relationHints: [],
    dialogueBursts: [
      [0, [10, 20], [4, 5]],
      [1, [30, 40], [4, 5]],
      [2, [50], [4]],
    ],
    contextEnvelope: {
      version: 'speaker-context-envelope-v4',
      blocks: [],
      targets: [
        [0, []],
        [1, []],
        [2, []],
        [3, []],
        [4, []],
      ],
      fingerprint: 'context_hash',
    },
    targets: [
      [10, 0, 1, 'line 10', [4, 5], [1, 2]],
      [20, 0, 1, 'line 20', [4, 5], [1, 2]],
      [30, 1, 1, 'line 30', [4, 5], [1, 2]],
      [40, 1, 1, 'line 40', [4, 5], [1, 2]],
      [50, 2, 1, 'line 50', [4], [1]],
    ],
    ordinalDictionaryFingerprint: 'ordinal_dictionary_hash',
  };
}

function sieveFixture(): DeterministicSpeakerSieveResultV1 {
  const decisions = [
    {
      spanId: 'span_10',
      spanIndex: 10,
      outcome: 'provider_target' as const,
      evidenceBits: 0,
      confidence: 0,
      ruleCode: 'candidate_missing',
      candidateEntityIds: [],
      fingerprint: 'decision_10',
    },
    {
      spanId: 'span_20',
      spanIndex: 20,
      outcome: 'provider_target' as const,
      evidenceBits: 0,
      confidence: 0,
      ruleCode: 'candidate_missing',
      candidateEntityIds: [],
      fingerprint: 'decision_20',
    },
    {
      spanId: 'span_30',
      spanIndex: 30,
      outcome: 'boundary_review' as const,
      evidenceBits: 0,
      confidence: 0,
      ruleCode: 'boundary_review_required',
      candidateEntityIds: [],
      fingerprint: 'decision_30',
    },
    {
      spanId: 'span_40',
      spanIndex: 40,
      outcome: 'window_split' as const,
      evidenceBits: 0,
      confidence: 0,
      ruleCode: 'candidate_hard_cap_exceeded',
      candidateEntityIds: [],
      fingerprint: 'decision_40',
    },
  ];
  return {
    version: 'deterministic-speaker-sieve-v2',
    decisions,
    acceptedSpanIds: [],
    providerTargetSpanIds: ['span_10', 'span_20'],
    boundaryReviewSpanIds: ['span_30'],
    windowSplitSpanIds: ['span_40'],
    calibrationFingerprint: 'calibration_disabled',
    fingerprint: 'sieve_hash',
  };
}

function validatedWire(
  packet: SceneSpeakerPacketV3,
  speakers: readonly number[],
  confidences: readonly number[],
  reviewTargetPositions: readonly number[] = [],
): ValidatedSpeakerWireV2 {
  return {
    wire: {
      v: 2,
      f: packet.fingerprint,
      s: speakers,
      q: confidences,
      e: speakers.map(() => 0),
      u: [],
      c: [],
      r: [],
      x: [],
    },
    issues: [],
    reviewTargetPositions,
    fingerprint: `validated_${packet.fingerprint}`,
  };
}

function pinnedPayload(packets: readonly SceneSpeakerPacketV3[]): SpeakerAttributionPinnedPayloadV3 {
  const sieve = sieveFixture();
  return {
    contract: SPEAKER_ATTRIBUTION_WORKFLOW_CONTRACT_VERSION,
    sourceManifestFingerprint: 'source_manifest_hash',
    spanInventoryHash: 'span_inventory_hash',
    mentionInventoryHash: 'mention_inventory_hash',
    candidateMemoryHash: 'candidate_memory_hash',
    addressEventRevision: 'address_revision_1',
    temporalSnapshotHash: 'temporal_snapshot_hash',
    dialogueBurstInventoryHash: 'dialogue_burst_inventory_hash',
    sieveVersion: sieve.version,
    sequenceDecoderVersion: 'dialogue-sequence-decision-v1',
    units: packets.map((packet) => {
      const outputBudget = estimateSpeakerOutputBudget({ targetSpanCount: packet.targets.length });
      return {
        sceneId: packet.sceneId,
        packet,
        outputBudget,
        generationPolicy: resolveLLMGenerationPolicy({
          providerId: 'gemini-ai-studio',
          modelId: 'gemini-3.1-flash-lite',
          taskKind: 'speaker_attribution',
          requestedOutputCap: outputBudget.requestedOutputCap,
          visibleOutputEstimate: outputBudget.visibleOutputEstimate,
        }),
      };
    }),
    canonicalSource: {
      chapter: {
        id: 'chapter_1',
        novelId: 'book_1',
        index: 0,
        title: 'Chapter 1',
        normalizedText: '',
        textHash: 'chapter_hash',
        rawStartOffset: 0,
        rawEndOffset: 0,
        characterCount: 0,
        paragraphCount: 0,
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
      },
      paragraphs: [],
      sourceParagraphs: [],
      characters: [],
      spanInventory: {
        version: 'speaker-span-inventory-v1',
        id: 'span_inventory_1',
        bookId: 'book_1',
        contentRevisionId: 'revision_1',
        chapterId: 'chapter_1',
        detectorVersion: 'test',
        spans: [],
        boundaryReviewSpanIds: [],
        fingerprint: 'span_inventory_hash',
      },
      dialogueBurstInventory: {
        version: 'dialogue-burst-inventory-v1',
        id: 'dialogue_burst_inventory_1',
        bookId: 'book_1',
        contentRevisionId: 'revision_1',
        chapterId: 'chapter_1',
        detectorVersion: 'test',
        bursts: [],
        fingerprint: 'dialogue_burst_inventory_hash',
      },
      sieve,
      speakerIdByEntityId: {},
    },
  };
}

describe('compact speaker packet slicing', () => {
  it('preserves global indexes, remaps local positions, filters bursts, and fingerprints deterministically', () => {
    const packet = packetFixture();
    const sliced = sliceSceneSpeakerPacketTargets(packet, [40, 20]);
    const repeated = sliceSceneSpeakerPacketTargets(packet, [20, 40]);

    expect(sliced.targets.map((target) => target[0])).toEqual([20, 40]);
    expect(sliced.targets[0]).toBe(packet.targets[1]);
    expect(sliced.targets[1]).toBe(packet.targets[3]);
    expect(sliced.newMentionOrdinalsByTarget).toEqual([
      [0, [0]],
      [1, [1]],
    ]);
    expect(sliced.dialogueBursts).toEqual([
      [0, [20], [4, 5]],
      [1, [40], [4, 5]],
    ]);
    expect(sliced.fingerprint).not.toBe(packet.fingerprint);
    expect(repeated.fingerprint).toBe(sliced.fingerprint);
  });

  it('rejects an empty or nonmatching target selection', () => {
    const packet = packetFixture();
    expect(() => sliceSceneSpeakerPacketTargets(packet, [])).toThrow(/at least one selected target/i);
    expect(() => sliceSceneSpeakerPacketTargets(packet, [999])).toThrow(/at least one selected target/i);
  });
});

describe('compact speaker workflow contract', () => {
  it('accepts distinct packet units for the same scene', () => {
    const packet = packetFixture();
    const first = sliceSceneSpeakerPacketTargets(packet, [10, 20]);
    const second = sliceSceneSpeakerPacketTargets(packet, [30, 40]);

    expect(first.sceneId).toBe(second.sceneId);
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(() => assertSpeakerAttributionPinnedPayload(pinnedPayload([first, second]))).not.toThrow();
  });

  it('rejects duplicate packet fingerprints even when units share a scene', () => {
    const packet = sliceSceneSpeakerPacketTargets(packetFixture(), [10, 20]);
    expect(() => assertSpeakerAttributionPinnedPayload(pinnedPayload([packet, packet]))).toThrow(
      /duplicate compact speaker packet unit/i,
    );
  });
});

describe('compact speaker risk routing', () => {
  it('keeps candidate and boundary risks inside the current window', () => {
    const routes = routeSpeakerRisks({
      sieve: sieveFixture(),
      attributedUnits: [],
      sequenceDecisions: [],
      targetSpanIndexes: [10, 30],
    });

    expect(routes.find((route) => route.riskClass === 'candidate')?.targetSpanIndexes).toEqual([10]);
    expect(routes.find((route) => route.riskClass === 'boundary')?.targetSpanIndexes).toEqual([30]);
    expect(routes.flatMap((route) => route.targetSpanIndexes)).not.toContain(20);
    expect(routes.flatMap((route) => route.targetSpanIndexes)).not.toContain(40);
  });

  it('routes observable candidate insufficiency without also classifying it as a boundary error', () => {
    const base = sieveFixture();
    const insufficient: DeterministicSpeakerSieveResultV1 = {
      ...base,
      decisions: [
        {
          spanId: 'span_10',
          spanIndex: 10,
          outcome: 'boundary_review',
          evidenceBits: 0,
          confidence: 0,
          ruleCode: 'candidate_insufficient',
          candidateEntityIds: [],
          fingerprint: 'decision_insufficient',
        },
      ],
      providerTargetSpanIds: [],
      boundaryReviewSpanIds: ['span_10'],
    };

    const routes = routeSpeakerRisks({
      sieve: insufficient,
      attributedUnits: [],
      sequenceDecisions: [],
      targetSpanIndexes: [10],
    });

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      riskClass: 'candidate',
      action: 'rebuild_candidates',
      targetSpanIndexes: [10],
      reasonCodes: ['candidate_insufficient'],
      escalationAllowed: false,
    });
  });
});

describe('independent speaker escalation', () => {
  it('does not treat a burst candidate union as observed conversation participants', () => {
    const base = packetFixture();
    const packet: SceneSpeakerPacketV3 = {
      ...base,
      targets: [[10, 0, 1, '짧음', [4], [0]]],
      dialogueBursts: [[0, [10], [4, 5, 6]]],
    };

    const [risk] = assessSpeakerEscalationTargetRisks(packet);

    expect(risk?.score).toBe(4);
    expect(risk?.reasonCodes).not.toContain('three_or_more_participants');
  });

  it('does not infer alternation from a burst candidate-pool union', () => {
    const base = packetFixture();
    const packet: SceneSpeakerPacketV3 = {
      ...base,
      targets: base.targets.slice(0, 2),
      dialogueBursts: [[0, [10, 20], [4, 5]]],
    };
    const validated = validatedWire(packet, [4, 4], [500, 500]);
    const withAlternatives: ValidatedSpeakerWireV2 = {
      ...validated,
      wire: { ...validated.wire, u: [0, 1], c: [[5], [5]], r: [4, 4] },
    };

    const [decision] = decodeDialogueSequences(packet, withAlternatives);

    expect(decision?.decoderMethod).toBe('none');
    expect(decision?.selectedSpeakerOrdinals).toEqual([4, 4]);
    expect(decision?.disagreementIndexes).toEqual([]);
  });

  it('keeps a selected distant-source candidate in escalation and review until calibrated', () => {
    const base = packetFixture();
    const packet: SceneSpeakerPacketV3 = {
      ...base,
      targets: [[10, 0, 1, '짧은 보고', [4], [1 << 9]]],
      dialogueBursts: [[0, [10], [4]]],
    };
    const primary = validatedWire(packet, [4], [950]);
    const routes = routeSpeakerRisks({
      sieve: sieveFixture(),
      attributedUnits: [{ packet, validatedWire: primary }],
      sequenceDecisions: [],
      targetSpanIndexes: [10],
    });
    const comparison = compareIndependentSpeakerEscalation({
      primaryPacket: packet,
      primary,
      escalationPacket: packet,
      escalation: validatedWire(packet, [4], [950]),
    });

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          riskClass: 'semantic',
          reasonCodes: ['distant_candidate_selected'],
          escalationAllowed: true,
        }),
      ]),
    );
    expect(comparison.resolvedSpanIndexes).toEqual([]);
    expect(comparison.uncalibratedSpanIndexes).toEqual([10]);
  });

  it('selects difficult targets from structural evidence without trusting model confidence', () => {
    const base = packetFixture();
    const packet: SceneSpeakerPacketV3 = {
      ...base,
      targets: base.targets.map((target) => [
        target[0],
        target[1],
        target[2],
        target[3],
        target[4],
        target[5].map(() => 0),
      ]),
      dialogueBursts: base.dialogueBursts.map(([ordinal, spans]) => [ordinal, spans, [4, 5, 6]]),
    };
    const risks = assessSpeakerEscalationTargetRisks(packet);
    const selected = selectBoundedSpeakerEscalationTargets(risks, 20);

    expect(risks.map((risk) => risk.spanIndex)).toEqual(expect.arrayContaining([10, 20, 30, 40]));
    expect(selected).toHaveLength(3);
    expect(selected.every((risk) => risk.reasonCodes.includes('no_direct_local_evidence'))).toBe(true);
  });

  it('never selects more than 15 percent or a configured lower ratio', () => {
    const requested = [...Array.from({ length: 100 }, (_, index) => index).reverse(), 0, 1, 2];
    const defaultSelection = selectIndependentEscalationTargets(requested, 100);
    const lowerSelection = selectIndependentEscalationTargets(requested, 100, 0.04);
    const overConfiguredSelection = selectIndependentEscalationTargets(requested, 100, 0.9);

    expect(defaultSelection).toHaveLength(15);
    expect(defaultSelection).toEqual(Array.from({ length: 15 }, (_, index) => index));
    expect(lowerSelection).toHaveLength(4);
    expect(overConfiguredSelection).toHaveLength(15);
  });

  it('resolves only matching grounded candidates with calibrated confidence', () => {
    const primaryPacket = packetFixture();
    const escalationPacket = sliceSceneSpeakerPacketTargets(primaryPacket, [10, 20, 30, 40, 50]);
    const primary = validatedWire(primaryPacket, [4, 4, 2, 3, 4], [900, 900, 950, 950, 849]);
    const escalation = validatedWire(escalationPacket, [4, 5, 2, 3, 4], [900, 900, 950, 950, 900]);

    const comparison = compareIndependentSpeakerEscalation({
      primaryPacket,
      primary,
      escalationPacket,
      escalation,
      minimumConfidence: 850,
    });

    expect(comparison.resolvedSpanIndexes).toEqual([10]);
    expect(comparison.disagreementSpanIndexes).toEqual([20]);
    expect(comparison.uncalibratedSpanIndexes).toEqual([30, 40, 50]);
  });
});
