import { structuredIntegrityHash, textIntegrityHash } from '@noveldesk/text-core/hash';
import { describe, expect, it } from 'vitest';
import type { Character, Paragraph } from '../../../domain/types';
import { resolveLLMGenerationPolicy } from '../../../providers/provider-generation-policy';
import type { SceneSpeakerPacketV3, SpeakerWireV2 } from '../../../providers/speaker-attribution/contracts';
import { estimateSpeakerOutputBudget } from '../../../providers/speaker-attribution/output-budget';
import {
  SPEAKER_ATTRIBUTION_WORKFLOW_CONTRACT_VERSION,
  type SpeakerAttributionPinnedPayloadV3,
} from '../../../providers/speaker-attribution/workflow-contract';
import type { NativeStructuredJsonBatch } from './contracts';
import {
  aggregateNativeSpeakerBatchCheckpoint,
  type NativeStructuredJsonBatchResult,
} from './native-speaker-batch-aggregator';
import { buildNativeSpeakerBatchMaterializeRequest } from './native-speaker-batch-materializer';

const character: Character = {
  id: 'character_1',
  novelId: 'book_1',
  canonicalName: 'Alex',
  aliases: [],
  color: '#335577',
  confidence: 1,
  isUserConfirmed: true,
};

function paragraph(index: number): Paragraph {
  const text = `Line ${index}`;
  return {
    id: `paragraph_${index}`,
    novelId: 'book_1',
    chapterId: 'chapter_1',
    index,
    text,
    textHash: textIntegrityHash(text),
    startOffsetInChapter: index * 20,
    endOffsetInChapter: index * 20 + text.length,
  };
}

function packet(index: number): SceneSpeakerPacketV3 {
  const text = `Line ${index}`;
  return {
    version: 6,
    contract: 'scene-speaker-packet-v6',
    fingerprint: `packet_${index}`,
    bookId: 'book_1',
    contentRevisionId: 'revision_1',
    chapterId: 'chapter_1',
    sceneId: `scene_${index}`,
    sourceRevision: 'span_inventory_hash',
    sourceManifestFingerprint: 'source_manifest_hash',
    spanInventoryHash: 'span_inventory_hash',
    mentionInventoryHash: 'mention_inventory_hash',
    candidateMemoryHash: 'candidate_memory_hash',
    temporalSnapshotId: `snapshot_${index}`,
    temporalSnapshotHash: 'temporal_snapshot_hash',
    dialogueBurstInventoryHash: 'dialogue_burst_hash',
    sieveVersion: 'deterministic-speaker-sieve-v2',
    correctionCursor: 'correction_hash',
    mode: 'reader_safe',
    candidates: [[4, 'entity_1', 'Alex', 1]],
    candidateSourceAnchors: [],
    mentions: [],
    mentionSourceIds: [],
    newMentionOrdinalsByTarget: [],
    recentTurns: [],
    relationDictionary: [],
    relationHints: [],
    dialogueBursts: [[index, [index], [4]]],
    contextEnvelope: {
      version: 'speaker-context-envelope-v4',
      blocks: [],
      targets: [[0, []]],
      fingerprint: `context_${index}`,
    },
    targets: [[index, index, 1, text, [4], [1]]],
    ordinalDictionaryFingerprint: `ordinal_hash_${index}`,
  };
}

function payload(packetCount: number): SpeakerAttributionPinnedPayloadV3 {
  const paragraphs = Array.from({ length: packetCount }, (_, index) => paragraph(index));
  const packets = Array.from({ length: packetCount }, (_, index) => packet(index));
  const spans = paragraphs.map((item, index) => ({
    id: `span_${index}`,
    bookId: 'book_1',
    contentRevisionId: 'revision_1',
    chapterId: 'chapter_1',
    paragraphId: item.id,
    sceneId: `scene_${index}`,
    spanIndex: index,
    startOffset: 0,
    endOffset: item.text.length,
    textHash: textIntegrityHash(item.text),
    type: 'dialogue' as const,
    voiceBearing: true,
    boundaryReview: false,
    boundaryCode: 'quoted_dialogue',
  }));
  const decisions = spans.map((span) => ({
    spanId: span.id,
    spanIndex: span.spanIndex,
    outcome: 'provider_target' as const,
    evidenceBits: 0,
    confidence: 0,
    ruleCode: 'speaker_ambiguous',
    candidateEntityIds: ['entity_1'],
    fingerprint: `sieve_decision_${span.spanIndex}`,
  }));
  return {
    contract: SPEAKER_ATTRIBUTION_WORKFLOW_CONTRACT_VERSION,
    sourceManifestFingerprint: 'source_manifest_hash',
    spanInventoryHash: 'span_inventory_hash',
    mentionInventoryHash: 'mention_inventory_hash',
    candidateMemoryHash: 'candidate_memory_hash',
    addressEventRevision: 'address_hash',
    temporalSnapshotHash: 'temporal_snapshot_hash',
    dialogueBurstInventoryHash: 'dialogue_burst_hash',
    sieveVersion: 'deterministic-speaker-sieve-v2',
    sequenceDecoderVersion: 'dialogue-sequence-decision-v1',
    units: packets.map((item) => {
      const outputBudget = estimateSpeakerOutputBudget({ targetSpanCount: 1 });
      return {
        sceneId: item.sceneId,
        packet: item,
        outputBudget,
        generationPolicy: resolveLLMGenerationPolicy({
          providerId: 'mock',
          modelId: 'mock-speaker-v1',
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
        index: 2,
        title: 'Chapter 1',
        normalizedText: paragraphs.map((item) => item.text).join('\n\n'),
        textHash: 'chapter_hash',
        rawStartOffset: 0,
        rawEndOffset: paragraphs.reduce((total, item) => total + item.text.length, 0),
        characterCount: paragraphs.reduce((total, item) => total + item.text.length, 0),
        paragraphCount: paragraphs.length,
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
      },
      paragraphs,
      sourceParagraphs: paragraphs.map((item) => ({
        paragraphId: item.id,
        chapterId: item.chapterId,
        paragraphIndex: item.index,
        text: item.text,
        textHash: item.textHash,
        startOffsetInChapter: item.startOffsetInChapter,
        endOffsetInChapter: item.endOffsetInChapter,
      })),
      characters: [character],
      spanInventory: {
        version: 'speaker-span-inventory-v1',
        id: 'span_inventory_1',
        bookId: 'book_1',
        contentRevisionId: 'revision_1',
        chapterId: 'chapter_1',
        detectorVersion: 'test',
        spans,
        boundaryReviewSpanIds: [],
        fingerprint: 'span_inventory_hash',
      },
      sieve: {
        version: 'deterministic-speaker-sieve-v2',
        decisions,
        acceptedSpanIds: [],
        providerTargetSpanIds: spans.map((span) => span.id),
        boundaryReviewSpanIds: [],
        windowSplitSpanIds: [],
        calibrationFingerprint: 'calibration_disabled',
        fingerprint: 'sieve_hash',
      },
      speakerIdByEntityId: { entity_1: character.id },
    },
  };
}

function batch(source: SpeakerAttributionPinnedPayloadV3): NativeStructuredJsonBatch {
  return buildNativeSpeakerBatchMaterializeRequest({
    workflowId: 'workflow_1',
    jobId: 'window_1',
    expectedFence: 3,
    source: { providerId: 'mock', modelId: 'mock-speaker-v1', providerOptions: {} },
    payload: source,
  }).batch;
}

function wire(packetFingerprint: string): SpeakerWireV2 {
  return {
    v: 2,
    f: packetFingerprint,
    s: [4],
    q: [920],
    e: [1],
    u: [],
    c: [],
    r: [],
    x: [],
  };
}

function checkpoint(sourceBatch: NativeStructuredJsonBatch): NativeStructuredJsonBatchResult {
  return {
    version: 'native-structured-json-batch-result-v1',
    units: sourceBatch.units.map((unit) => {
      const output = wire(unit.packetFingerprint);
      return {
        id: unit.id,
        packetFingerprint: unit.packetFingerprint,
        requestHash: structuredIntegrityHash(unit.request),
        outputHash: structuredIntegrityHash(output),
        output,
      };
    }),
  };
}

function aggregate(source: SpeakerAttributionPinnedPayloadV3, result = checkpoint(batch(source))) {
  return aggregateNativeSpeakerBatchCheckpoint({
    jobId: 'window_1',
    correctionFingerprint: 'correction_hash',
    payload: source,
    batch: batch(source),
    checkpointOutput: result,
  });
}

describe('native compact speaker batch aggregator', () => {
  it('accepts a zero-packet checkpoint and returns text-free dependency material', () => {
    const source = payload(0);
    const result = aggregate(source);

    expect(result.result.segments).toEqual([]);
    expect(result.sequenceRecords).toEqual([]);
    expect(result.speakerProvenanceDrafts).toEqual([]);
    expect(result.artifactDependencyIds).toContain('correction_hash');
    expect(result).not.toHaveProperty('artifactDependencies');
    expect(JSON.stringify({ dependencies: result.artifactDependencyIds, metadata: result.metadata })).not.toContain(
      'Line ',
    );
  });

  it('strictly decodes one packet into canonical labels, sequence state, risk, and provenance drafts', () => {
    const result = aggregate(payload(1));

    expect(result.result.segments).toHaveLength(1);
    expect(result.result.segments[0]).toMatchObject({ speakerId: 'character_1', confidence: 0.92 });
    expect(result.sequenceRecords).toHaveLength(1);
    expect(result.riskRoutes).toEqual([]);
    expect(result.speakerProvenanceDrafts[0]).toMatchObject({
      packetFingerprint: 'packet_0',
      resolutionKind: 'provider_candidate',
      canonicalSpeakerId: 'character_1',
    });
    expect(result.artifactDependencyIds).toEqual([...result.artifactDependencyIds].sort());
    expect(result.metadata.speakerProvenanceCount).toBe(1);
  });

  it('aggregates multiple packets in materialized order', () => {
    const result = aggregate(payload(3));

    expect(result.result.segments.map((segment) => segment.paragraphId)).toEqual([
      'paragraph_0',
      'paragraph_1',
      'paragraph_2',
    ]);
    expect(result.sequenceRecords).toHaveLength(3);
    expect(result.metadata.packetFingerprints).toEqual(['packet_0', 'packet_1', 'packet_2']);
    expect(result.speakerProvenanceDrafts).toHaveLength(3);
  });

  it('rejects duplicate, missing, reordered, and stale packet units', () => {
    const source = payload(2);
    const sourceBatch = batch(source);
    const valid = checkpoint(sourceBatch);
    const first = valid.units[0]!;
    const second = valid.units[1]!;

    expect(() => aggregate(source, { ...valid, units: [first, first] })).toThrow(/duplicate/i);
    expect(() => aggregate(source, { ...valid, units: [first] })).toThrow(/missing packet units/i);
    expect(() => aggregate(source, { ...valid, units: [second, first] })).toThrow(/reordered/i);
    expect(() =>
      aggregate(source, {
        ...valid,
        units: [{ ...first, packetFingerprint: 'packet_stale' }, second],
      }),
    ).toThrow(/fingerprint is stale/i);
  });

  it('rejects request/output hash tampering and non-strict wire output', () => {
    const source = payload(1);
    const valid = checkpoint(batch(source));
    const unit = valid.units[0]!;

    expect(() => aggregate(source, { ...valid, units: [{ ...unit, requestHash: 'sha256:tampered' }] })).toThrow(
      /request hash is invalid/i,
    );
    expect(() => aggregate(source, { ...valid, units: [{ ...unit, outputHash: 'sha256:tampered' }] })).toThrow(
      /output hash is invalid/i,
    );
    const output = { ...(unit.output as SpeakerWireV2), unexpected: true };
    expect(() =>
      aggregate(source, {
        ...valid,
        units: [{ ...unit, output, outputHash: structuredIntegrityHash(output) }],
      }),
    ).toThrow(/missing or additional fields/i);
  });
});
