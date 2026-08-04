import { describe, expect, it } from 'vitest';
import {
  assertAcceptedSpeakerProvenance,
  assertNoDuplicateActiveSpeakerProvenance,
  createAcceptedSpeakerProvenance,
  createManualReviewSpeakerProvenanceDraft,
  parseSpeakerSegmentProvenanceDrafts,
  transitionAcceptedSpeakerProvenance,
  type SpeakerSegmentProvenanceDraftV1,
} from './accepted-speaker-provenance';

const draft = (overrides: Partial<SpeakerSegmentProvenanceDraftV1> = {}): SpeakerSegmentProvenanceDraftV1 => ({
  bookId: 'book_1',
  contentRevisionId: 'revision_1',
  chapterId: 'chapter_1',
  paragraphId: 'paragraph_1',
  segmentId: 'segment_1',
  sourceSpanId: 'span_1',
  sceneId: 'scene_1',
  dialogueBurstId: 'burst_1',
  narrativeOrder: 12,
  speakerEntityId: 'provisional_entity_1',
  canonicalSpeakerId: 'unknown',
  resolutionKind: 'provider_new_mention',
  sourceManifestFingerprint: 'manifest_fingerprint_1',
  packetFingerprint: 'packet_fingerprint_1',
  temporalSnapshotId: 'snapshot_1',
  sequenceDecisionId: 'sequence_1',
  confidence: 0.73,
  ...overrides,
});

describe('accepted speaker provenance', () => {
  it('keeps noncanonical entities distinct even when both canonical labels are unknown', () => {
    const first = createAcceptedSpeakerProvenance(draft(), 'artifact_1', '2026-07-13T00:00:00.000Z');
    const second = createAcceptedSpeakerProvenance(
      draft({ speakerEntityId: 'provisional_entity_2' }),
      'artifact_1',
      '2026-07-13T00:00:00.000Z',
    );

    expect(first.canonicalSpeakerId).toBe('unknown');
    expect(second.canonicalSpeakerId).toBe('unknown');
    expect(second.id).not.toBe(first.id);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('is idempotent across creation times and validates its immutable core', () => {
    const first = createAcceptedSpeakerProvenance(draft(), 'artifact_1', '2026-07-13T00:00:00.000Z');
    const second = createAcceptedSpeakerProvenance(draft(), 'artifact_1', '2026-07-13T01:00:00.000Z');

    expect(second.id).toBe(first.id);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.createdAt).not.toBe(first.createdAt);
    expect(() => assertAcceptedSpeakerProvenance(first)).not.toThrow();
  });

  it('detects immutable-core tampering', () => {
    const accepted = createAcceptedSpeakerProvenance(draft(), 'artifact_1');
    const tampered = { ...accepted, speakerEntityId: 'substituted_entity' };

    expect(() => assertAcceptedSpeakerProvenance(tampered)).toThrow(/invalid immutable core/i);
  });

  it('allows only active to terminal transitions while preserving immutable identity', () => {
    const active = createAcceptedSpeakerProvenance(draft(), 'artifact_1');
    const stale = transitionAcceptedSpeakerProvenance(active, 'stale', 'source manifest changed');

    expect(stale).toMatchObject({
      status: 'stale',
      staleReason: 'source manifest changed',
      id: active.id,
      fingerprint: active.fingerprint,
      createdAt: active.createdAt,
    });
    expect(() => transitionAcceptedSpeakerProvenance(stale, 'superseded')).toThrow(/cannot transition/i);
    expect(() => transitionAcceptedSpeakerProvenance(active, 'stale')).toThrow(/staleReason is required/i);
    expect(() => transitionAcceptedSpeakerProvenance(active, 'superseded', 'not applicable')).toThrow(
      /cannot have a stale reason/i,
    );
  });

  it('rejects duplicate active provenance within a revision and segment', () => {
    const first = createAcceptedSpeakerProvenance(draft(), 'artifact_1');
    const duplicate = createAcceptedSpeakerProvenance(draft({ speakerEntityId: 'provisional_entity_2' }), 'artifact_2');
    const previous = transitionAcceptedSpeakerProvenance(first, 'superseded');

    expect(() => assertNoDuplicateActiveSpeakerProvenance([first, duplicate])).toThrow(/duplicate active/i);
    expect(() => assertNoDuplicateActiveSpeakerProvenance([previous, duplicate])).not.toThrow();
  });

  it('parses only bounded provenance draft objects', () => {
    expect(parseSpeakerSegmentProvenanceDrafts([draft()])).toEqual([draft()]);
    expect(parseSpeakerSegmentProvenanceDrafts(undefined)).toEqual([]);
    expect(() => parseSpeakerSegmentProvenanceDrafts({})).toThrow(/must be an array/i);
    expect(() => parseSpeakerSegmentProvenanceDrafts([{ ...draft(), confidence: 2 }])).toThrow(/confidence/i);
  });
});

describe('manual review speaker provenance', () => {
  it('preserves the original noncanonical entity when the speaker was not edited', () => {
    const original = draft();
    const reviewed = createManualReviewSpeakerProvenanceDraft({
      draft: original,
      promotedSpeakerId: 'unknown',
      speakerEntityIdByCanonicalSpeakerId: {},
      speakerEdited: false,
    });

    expect(reviewed).toMatchObject({
      speakerEntityId: original.speakerEntityId,
      canonicalSpeakerId: 'unknown',
      resolutionKind: 'manual_review',
      sourceSpanId: original.sourceSpanId,
      sourceManifestFingerprint: original.sourceManifestFingerprint,
      packetFingerprint: original.packetFingerprint,
      temporalSnapshotId: original.temporalSnapshotId,
      sequenceDecisionId: original.sequenceDecisionId,
    });
  });

  it('maps edited canonical labels and removes the entity for an explicit unknown edit', () => {
    const canonical = createManualReviewSpeakerProvenanceDraft({
      draft: draft(),
      promotedSpeakerId: 'character_7',
      speakerEntityIdByCanonicalSpeakerId: { character_7: 'canonical_entity_7' },
      speakerEdited: true,
    });
    const unknown = createManualReviewSpeakerProvenanceDraft({
      draft: canonical,
      promotedSpeakerId: 'unknown',
      speakerEntityIdByCanonicalSpeakerId: { character_7: 'canonical_entity_7' },
      speakerEdited: true,
    });
    const narrator = createManualReviewSpeakerProvenanceDraft({
      draft: draft(),
      promotedSpeakerId: 'narrator',
      speakerEntityIdByCanonicalSpeakerId: {},
      speakerEdited: true,
    });

    expect(canonical.speakerEntityId).toBe('canonical_entity_7');
    expect(unknown.speakerEntityId).toBeUndefined();
    expect(narrator.speakerEntityId).toBe('narrator');
    expect(() =>
      createManualReviewSpeakerProvenanceDraft({
        draft: draft(),
        promotedSpeakerId: 'character_missing',
        speakerEntityIdByCanonicalSpeakerId: {},
        speakerEdited: true,
      }),
    ).toThrow(/speaker entity for character_missing is required/i);
  });
});
