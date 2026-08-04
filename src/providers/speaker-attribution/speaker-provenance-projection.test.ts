import { describe, expect, it } from 'vitest';
import type { DialogueBurstInventoryV1, SpeakerSpanInventoryV1 } from '@noveldesk/text-core/speaker-attribution';
import type { ChapterLabelingResult } from '../ai';
import type { CanonicalSpeakerAttributionUnitV3 } from './canonical-batch-expander';
import type { DeterministicSpeakerSieveResultV1 } from './deterministic-sieve';
import {
  projectSpeakerSegmentProvenanceDrafts,
  speakerSegmentProvenanceDraftsFingerprint,
} from './speaker-provenance-projection';

const spans = {
  fingerprint: 'span_inventory_1',
  spans: [
    { id: 'span_0', spanIndex: 0, paragraphId: 'paragraph_0', sceneId: 'scene_0' },
    { id: 'span_1', spanIndex: 1, paragraphId: 'paragraph_1', sceneId: 'scene_0' },
    { id: 'span_2', spanIndex: 2, paragraphId: 'paragraph_2', sceneId: 'scene_0' },
  ],
} as unknown as SpeakerSpanInventoryV1;

const bursts = {
  fingerprint: 'burst_inventory_1',
  bursts: [{ id: 'burst_1', sceneId: 'scene_0', spanIds: ['span_1', 'span_2'] }],
} as unknown as DialogueBurstInventoryV1;

const sieve = {
  decisions: [
    {
      spanId: 'span_0',
      outcome: 'accepted',
      speakerEntityId: 'narrator',
      candidateEntityIds: [],
      confidence: 1,
      ruleCode: 'narrator',
    },
  ],
} as unknown as DeterministicSpeakerSieveResultV1;

const result: ChapterLabelingResult = {
  characters: [],
  segments: [
    {
      id: 'segment_0',
      novelId: 'book_1',
      chapterId: 'chapter_1',
      paragraphId: 'paragraph_0',
      segmentIndex: 0,
      startOffset: 0,
      endOffset: 5,
      segmentTextHash: 'hash_0',
      type: 'narration',
      speakerId: 'narrator',
      candidateSpeakers: [],
      listenerIds: [],
      emotion: 'neutral',
      confidence: 1,
      isUserCorrected: false,
    },
    {
      id: 'segment_1',
      novelId: 'book_1',
      chapterId: 'chapter_1',
      paragraphId: 'paragraph_1',
      segmentIndex: 1,
      startOffset: 0,
      endOffset: 5,
      segmentTextHash: 'hash_1',
      type: 'quoted_dialogue',
      speakerId: 'unknown',
      candidateSpeakers: ['entity_minor_1'],
      listenerIds: [],
      emotion: 'neutral',
      confidence: 0.9,
      isUserCorrected: false,
    },
    {
      id: 'segment_2',
      novelId: 'book_1',
      chapterId: 'chapter_1',
      paragraphId: 'paragraph_2',
      segmentIndex: 2,
      startOffset: 0,
      endOffset: 5,
      segmentTextHash: 'hash_2',
      type: 'quoted_dialogue',
      speakerId: 'unknown',
      candidateSpeakers: ['pending_1'],
      listenerIds: [],
      emotion: 'neutral',
      confidence: 0.8,
      isUserCorrected: false,
    },
  ],
};

const unit = {
  packet: {
    fingerprint: 'packet_1',
    contentRevisionId: 'revision_1',
    temporalSnapshotId: 'snapshot_1',
    candidates: [[4, 'entity_minor_1', 'Minor', 0]],
    mentionSourceIds: [[0, 'mention_source_1']],
    targets: [
      [1, 0, 1, 'redacted in fixture', [4], [0]],
      [2, 0, 1, 'redacted in fixture', [], []],
    ],
  },
  validatedWire: { wire: { s: [4, 3], x: [[1, 0]] } },
  sequenceDecisions: [
    {
      id: 'sequence_1',
      spanIndexes: [1, 2],
      selectedSpeakerOrdinals: [4, 3],
    },
  ],
} as unknown as CanonicalSpeakerAttributionUnitV3;

describe('speaker provenance projection', () => {
  it('keeps deterministic, noncanonical candidate and NEW_FROM_MENTION identities separate', () => {
    const drafts = projectSpeakerSegmentProvenanceDrafts({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 2,
      sourceManifestFingerprint: 'manifest_1',
      spanInventory: spans,
      dialogueBurstInventory: bursts,
      sieve,
      result,
      units: [unit],
    });

    expect(drafts).toEqual([
      expect.objectContaining({
        segmentId: 'segment_0',
        speakerEntityId: 'narrator',
        resolutionKind: 'deterministic',
        narrativeOrder: 2_000_000,
      }),
      expect.objectContaining({
        segmentId: 'segment_1',
        speakerEntityId: 'entity_minor_1',
        canonicalSpeakerId: 'unknown',
        resolutionKind: 'provider_candidate',
        dialogueBurstId: 'burst_1',
        sequenceDecisionId: 'sequence_1',
      }),
      expect.objectContaining({
        segmentId: 'segment_2',
        canonicalSpeakerId: 'unknown',
        resolutionKind: 'provider_new_mention',
        packetFingerprint: 'packet_1',
        temporalSnapshotId: 'snapshot_1',
      }),
    ]);
    expect(drafts[2]?.speakerEntityId).toMatch(/^pending_speaker_entity_[0-9a-f]{32}$/u);
    expect(drafts[2]?.speakerEntityId).not.toBe(drafts[1]?.speakerEntityId);
    expect(speakerSegmentProvenanceDraftsFingerprint(drafts)).toBe(
      speakerSegmentProvenanceDraftsFingerprint([...drafts].reverse()),
    );
  });

  it('rejects duplicate packet coverage instead of silently replacing provenance', () => {
    expect(() =>
      projectSpeakerSegmentProvenanceDrafts({
        bookId: 'book_1',
        contentRevisionId: 'revision_1',
        chapterId: 'chapter_1',
        chapterIndex: 0,
        sourceManifestFingerprint: 'manifest_1',
        spanInventory: spans,
        dialogueBurstInventory: bursts,
        sieve,
        result,
        units: [unit, unit],
      }),
    ).toThrow(/target is duplicated/i);
  });
});
