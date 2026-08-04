import { describe, expect, it } from 'vitest';
import {
  assertNoAmbiguousSpeakerIdentityEdges,
  assertNoAmbiguousSpeakerVoiceIdentities,
  createSpeakerIdentityEdge,
  createSpeakerVoiceIdentity,
  resolveReaderSafeSpeakerIdentity,
  resolveReaderSafeVoiceIdentity,
} from './speaker-identity';

const edgeInput = {
  bookId: 'book_1',
  contentRevisionId: 'revision_1',
  sourceRevealAnchorId: 'correction_1',
  speakerEntityId: 'speaker_1',
  characterId: 'character_1',
  visibleFromNarrativeOrder: 10,
  visibleToNarrativeOrder: 20,
  confidenceKind: 'human_verified' as const,
  status: 'active' as const,
  provenance: 'user_correction' as const,
};

const voiceInput = {
  bookId: 'book_1',
  contentRevisionId: 'revision_1',
  sourceRevealAnchorId: 'voice_assignment_1',
  speakerEntityId: 'speaker_1',
  voiceIdentityId: 'voice_1',
  visibleFromNarrativeOrder: 10,
  assignmentKind: 'character_profile' as const,
  userPinned: false,
};

describe('reader-visible speaker identities', () => {
  it('derives retry-stable IDs without creation time', () => {
    const first = createSpeakerIdentityEdge({ ...edgeInput, createdAt: '2026-07-13T00:00:00.000Z' });
    const retry = createSpeakerIdentityEdge({ ...edgeInput, createdAt: '2026-07-13T01:00:00.000Z' });
    const otherAnchor = createSpeakerIdentityEdge({ ...edgeInput, sourceRevealAnchorId: 'correction_2' });

    expect(retry.id).toBe(first.id);
    expect(retry.fingerprint).toBe(first.fingerprint);
    expect(otherAnchor.id).not.toBe(first.id);

    const firstVoice = createSpeakerVoiceIdentity({ ...voiceInput, createdAt: '2026-07-13T00:00:00.000Z' });
    const retriedVoice = createSpeakerVoiceIdentity({ ...voiceInput, createdAt: '2026-07-13T01:00:00.000Z' });
    expect(retriedVoice.id).toBe(firstVoice.id);
    expect(retriedVoice.fingerprint).toBe(firstVoice.fingerprint);
  });

  it('does not reveal an identity before its source anchor interval', () => {
    const edge = createSpeakerIdentityEdge(edgeInput);
    const otherRevision = createSpeakerIdentityEdge({
      ...edgeInput,
      contentRevisionId: 'revision_2',
      characterId: 'character_other_revision',
    });

    expect(resolveReaderSafeSpeakerIdentity([edge], 'speaker_1', 9, 'revision_1')).toBeUndefined();
    expect(resolveReaderSafeSpeakerIdentity([otherRevision, edge], 'speaker_1', 10, 'revision_1')).toBe('character_1');
    expect(resolveReaderSafeSpeakerIdentity([edge], 'speaker_1', 21, 'revision_1')).toBeUndefined();
  });

  it('gives a pinned voice precedence without exposing it before reveal', () => {
    const fallback = createSpeakerVoiceIdentity({ ...voiceInput, visibleFromNarrativeOrder: 15 });
    const pinned = createSpeakerVoiceIdentity({
      ...voiceInput,
      sourceRevealAnchorId: 'voice_assignment_pinned',
      voiceIdentityId: 'voice_pinned',
      userPinned: true,
    });

    expect(resolveReaderSafeVoiceIdentity([fallback, pinned], 'speaker_1', 9, 'revision_1')).toBeUndefined();
    expect(resolveReaderSafeVoiceIdentity([fallback, pinned], 'speaker_1', 18, 'revision_1')?.voiceIdentityId).toBe(
      'voice_pinned',
    );
  });

  it('rejects invalid intervals and ambiguous active mappings', () => {
    expect(() => createSpeakerIdentityEdge({ ...edgeInput, visibleFromNarrativeOrder: -1 })).toThrow(
      /nonnegative integer/i,
    );
    expect(() => createSpeakerIdentityEdge({ ...edgeInput, visibleFromNarrativeOrder: Number.NaN })).toThrow(
      /nonnegative integer/i,
    );
    expect(() =>
      createSpeakerIdentityEdge({
        ...edgeInput,
        visibleFromNarrativeOrder: 20,
        visibleToNarrativeOrder: 19,
      }),
    ).toThrow(/at or after/i);

    const first = createSpeakerIdentityEdge(edgeInput);
    const conflicting = createSpeakerIdentityEdge({
      ...edgeInput,
      sourceRevealAnchorId: 'correction_conflict',
      characterId: 'character_2',
      visibleFromNarrativeOrder: 20,
      visibleToNarrativeOrder: 30,
    });
    expect(() => assertNoAmbiguousSpeakerIdentityEdges([first, conflicting])).toThrow(/ambiguous active interval/i);

    const fallback = createSpeakerVoiceIdentity(voiceInput);
    const conflictingFallback = createSpeakerVoiceIdentity({
      ...voiceInput,
      sourceRevealAnchorId: 'voice_assignment_conflict',
      voiceIdentityId: 'voice_2',
    });
    const pinned = createSpeakerVoiceIdentity({
      ...voiceInput,
      sourceRevealAnchorId: 'voice_assignment_pinned',
      voiceIdentityId: 'voice_pinned',
      userPinned: true,
    });
    expect(() => assertNoAmbiguousSpeakerVoiceIdentities([fallback, conflictingFallback])).toThrow(
      /ambiguous active interval/i,
    );
    expect(() => assertNoAmbiguousSpeakerVoiceIdentities([fallback, pinned])).not.toThrow();
  });
});
