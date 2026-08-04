import { describe, expect, it } from 'vitest';
import { resolveLLMGenerationPolicy } from '../../../providers/provider-generation-policy';
import type { SceneSpeakerPacketV3 } from '../../../providers/speaker-attribution/contracts';
import { estimateSpeakerOutputBudget } from '../../../providers/speaker-attribution/output-budget';
import {
  SPEAKER_ATTRIBUTION_WORKFLOW_CONTRACT_VERSION,
  type SpeakerAttributionPinnedPayloadV3,
} from '../../../providers/speaker-attribution/workflow-contract';
import {
  buildNativeSpeakerBatchMaterializeRequest,
  nativeSpeakerBatchUnitId,
  NativeSpeakerIndependentEscalationUnsupportedError,
} from './native-speaker-batch-materializer';

function packet(fingerprint: string, sceneId: string): SceneSpeakerPacketV3 {
  return {
    version: 6,
    contract: 'scene-speaker-packet-v6',
    fingerprint,
    bookId: 'book_1',
    contentRevisionId: 'revision_1',
    chapterId: 'chapter_1',
    sceneId,
    sourceRevision: 'span_inventory_hash',
    sourceManifestFingerprint: 'source_manifest_hash',
    spanInventoryHash: 'span_inventory_hash',
    mentionInventoryHash: 'mention_inventory_hash',
    candidateMemoryHash: 'candidate_memory_hash',
    temporalSnapshotId: `snapshot_${sceneId}`,
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
    dialogueBursts: [[0, [0], [4]]],
    contextEnvelope: {
      version: 'speaker-context-envelope-v4',
      blocks: [],
      targets: [[0, []]],
      fingerprint: 'context_hash',
    },
    targets: [[0, 0, 1, 'Hello', [4], [1]]],
    ordinalDictionaryFingerprint: 'ordinal_hash',
  };
}

function payload(packets: readonly SceneSpeakerPacketV3[]): SpeakerAttributionPinnedPayloadV3 {
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
      const outputBudget = estimateSpeakerOutputBudget({ targetSpanCount: item.targets.length });
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
      sieve: {
        version: 'deterministic-speaker-sieve-v2',
        decisions: [],
        acceptedSpanIds: [],
        providerTargetSpanIds: [],
        boundaryReviewSpanIds: [],
        windowSplitSpanIds: [],
        calibrationFingerprint: 'calibration_disabled',
        fingerprint: 'sieve_hash',
      },
      speakerIdByEntityId: {},
    },
  };
}

const source = {
  providerId: 'mock',
  modelId: 'mock-speaker-v1',
  providerOptions: {},
};

describe('native compact speaker batch materializer', () => {
  it('materializes a valid zero-packet batch under the window job id', () => {
    const request = buildNativeSpeakerBatchMaterializeRequest({
      workflowId: 'workflow_1',
      jobId: 'window_1',
      expectedFence: 7,
      source,
      payload: payload([]),
    });

    expect(request).toEqual({
      workflowId: 'workflow_1',
      jobId: 'window_1',
      expectedFence: 7,
      batch: { version: 'native-structured-json-batch-v1', units: [] },
    });
    expect(request).not.toHaveProperty('request');
  });

  it('keeps multiple packets as ordered batch units instead of logical jobs', () => {
    const packets = [packet('packet_1', 'scene_1'), packet('packet_2', 'scene_2')];
    const request = buildNativeSpeakerBatchMaterializeRequest({
      workflowId: 'workflow_1',
      jobId: 'window_1',
      expectedFence: 7,
      source,
      payload: payload(packets),
    });

    expect(request.jobId).toBe('window_1');
    expect(request.batch.units.map((unit) => unit.packetFingerprint)).toEqual(['packet_1', 'packet_2']);
    expect(request.batch.units.map((unit) => unit.id)).toEqual([
      nativeSpeakerBatchUnitId('window_1', 'packet_1'),
      nativeSpeakerBatchUnitId('window_1', 'packet_2'),
    ]);
    expect(request.batch.units.every((unit) => unit.request.jsonSchemaName === 'speaker_wire_v2')).toBe(true);
  });

  it('rejects independent escalation before constructing a dispatch batch', () => {
    expect(() =>
      buildNativeSpeakerBatchMaterializeRequest({
        workflowId: 'workflow_1',
        jobId: 'window_1',
        expectedFence: 7,
        source: { ...source, providerOptions: { speakerEscalationEnabled: true } },
        payload: payload([packet('packet_1', 'scene_1')]),
      }),
    ).toThrowError(NativeSpeakerIndependentEscalationUnsupportedError);

    try {
      buildNativeSpeakerBatchMaterializeRequest({
        workflowId: 'workflow_1',
        jobId: 'window_1',
        expectedFence: 7,
        source: { ...source, providerOptions: { speakerEscalationEnabled: true } },
        payload: payload([]),
      });
    } catch (error) {
      expect(error).toMatchObject({ code: 'native_speaker_independent_escalation_unsupported' });
    }
  });
});
