import type { Character, LabeledSegment, Paragraph, VoiceProfile } from '../domain/types';
import {
  createAcceptedSpeakerProvenance,
  transitionAcceptedSpeakerProvenance,
  type AcceptedSpeakerProvenanceV1,
} from '../providers/speaker-attribution/accepted-speaker-provenance';
import type { TtsVoiceBindingV1 } from '../providers/voice-casting';
import { buildPlayableTtsSegments } from '../providers/tts-playback';
import { describe, expect, it } from 'vitest';

const paragraph: Paragraph = {
  id: 'paragraph-1',
  novelId: 'book-s8',
  chapterId: 'chapter-1',
  index: 0,
  text: '"Hello."',
  startOffsetInChapter: 0,
  endOffsetInChapter: 8,
  textHash: 'paragraph-hash',
};

const character: Character = {
  id: 'alice',
  novelId: 'book-s8',
  canonicalName: 'Alice',
  aliases: [],
  color: '#336699',
  confidence: 1,
  isUserConfirmed: true,
};

const existingProfile: VoiceProfile = {
  id: 'voice-existing',
  novelId: 'book-s8',
  characterId: 'alice',
  role: 'character',
  providerId: 'system',
  providerVoiceId: 'system-existing',
  label: 'Existing Alice voice',
  speed: 1,
  isUserSelected: true,
};

const assignedProfile: VoiceProfile = {
  id: 'voice-assigned',
  novelId: 'book-s8',
  role: 'character',
  providerId: 'system',
  providerVoiceId: 'system-assigned',
  providerModel: 'system-v1',
  label: 'Assigned pool voice',
  speed: 1.2,
  isUserSelected: false,
};

const segment: LabeledSegment = {
  id: 'segment-1',
  novelId: 'book-s8',
  chapterId: 'chapter-1',
  paragraphId: 'paragraph-1',
  segmentIndex: 0,
  startOffset: 0,
  endOffset: 8,
  segmentTextHash: 'segment-hash',
  type: 'quoted_dialogue',
  speakerId: 'alice',
  candidateSpeakers: ['alice'],
  listenerIds: [],
  emotion: 'calm',
  confidence: 0.97,
  voiceProfileId: existingProfile.id,
  isUserCorrected: false,
};

function provenance(artifactId: string): AcceptedSpeakerProvenanceV1 {
  return createAcceptedSpeakerProvenance(
    {
      bookId: 'book-s8',
      contentRevisionId: 'content-s8',
      chapterId: 'chapter-1',
      paragraphId: paragraph.id,
      segmentId: segment.id,
      sourceSpanId: 'span-1',
      sceneId: 'scene-1',
      dialogueBurstId: 'burst-1',
      narrativeOrder: 42,
      speakerEntityId: 'speaker-alice',
      canonicalSpeakerId: 'alice',
      resolutionKind: 'provider_candidate',
      sourceManifestFingerprint: 'manifest-s8',
      temporalSnapshotId: 'snapshot-1',
      sequenceDecisionId: 'sequence-1',
      confidence: 0.97,
    },
    artifactId,
    '2026-07-13T00:00:00.000Z',
  );
}

function binding(acceptedProvenanceId: string): TtsVoiceBindingV1 {
  return {
    bookId: 'book-s8',
    contentRevisionId: 'content-s8',
    chapterId: 'chapter-1',
    paragraphId: paragraph.id,
    segmentId: segment.id,
    acceptedProvenanceId,
    speakerEntityId: 'speaker-alice',
    sceneId: 'scene-1',
    dialogueBurstId: 'burst-1',
    narrativeOrder: 42,
    voiceIdentityId: 'voice-identity-alice',
    voiceProfileId: assignedProfile.id,
    voiceProfile: assignedProfile,
    voiceTier: 'B_stable_pool',
    voicePoolKey: 'default:system:system-v1',
    voiceAssignmentRevision: 'assignment-revision-7',
  };
}

function playback(input: {
  acceptedSpeakerProvenance: readonly AcceptedSpeakerProvenanceV1[];
  voiceBindings: readonly TtsVoiceBindingV1[];
  automatic?: boolean;
}) {
  return buildPlayableTtsSegments({
    paragraph,
    segments: [input.automatic ? { ...segment, voiceProfileId: undefined } : segment],
    characters: [character],
    voiceProfiles: input.automatic ? [assignedProfile] : [existingProfile, assignedProfile],
    fallbackVoiceURI: 'system-fallback',
    baseRate: 1,
    acceptedSpeakerProvenance: input.acceptedSpeakerProvenance,
    voiceBindings: input.voiceBindings,
  })[0]!;
}

describe('S8 voice-casting playback integration', () => {
  it('applies a provenance-matched binding and exposes assignment audit fields', () => {
    const accepted = provenance('artifact-active');

    expect(
      playback({ acceptedSpeakerProvenance: [accepted], voiceBindings: [binding(accepted.id)], automatic: true }),
    ).toMatchObject({
      speakerId: 'alice',
      speakerEntityId: 'speaker-alice',
      speakerProvenanceId: accepted.id,
      speakerSceneId: 'scene-1',
      dialogueBurstId: 'burst-1',
      narrativeOrder: 42,
      readerStateSnapshotId: 'snapshot-1',
      dialogueSequenceDecisionId: 'sequence-1',
      voiceProfileId: assignedProfile.id,
      voiceURI: assignedProfile.providerVoiceId,
      rate: 1.2,
      voiceIdentityId: 'voice-identity-alice',
      voiceTier: 'B_stable_pool',
      voicePoolKey: 'default:system:system-v1',
      voiceAssignmentRevision: 'assignment-revision-7',
    });
  });

  it('keeps an explicit user-selected voice ahead of an automatic binding', () => {
    const accepted = provenance('artifact-user-selected');
    const result = playback({ acceptedSpeakerProvenance: [accepted], voiceBindings: [binding(accepted.id)] });

    expect(result).toMatchObject({
      voiceProfileId: existingProfile.id,
      voiceURI: existingProfile.providerVoiceId,
      speakerProvenanceId: accepted.id,
    });
    expect(result.voiceIdentityId).toBeUndefined();
    expect(result.voiceAssignmentRevision).toBeUndefined();
  });

  it('replaces a legacy automatic segment profile with the current casting binding', () => {
    const accepted = provenance('artifact-legacy-profile');
    const legacyProfile = { ...existingProfile, isUserSelected: false };
    const [result] = buildPlayableTtsSegments({
      paragraph,
      segments: [segment],
      characters: [character],
      voiceProfiles: [legacyProfile, assignedProfile],
      fallbackVoiceURI: 'system-fallback',
      baseRate: 1,
      acceptedSpeakerProvenance: [accepted],
      voiceBindings: [binding(accepted.id)],
    });

    expect(result).toMatchObject({
      voiceProfileId: assignedProfile.id,
      voiceIdentityId: 'voice-identity-alice',
      voiceAssignmentRevision: 'assignment-revision-7',
    });
  });

  it('does not let a mismatched provenance binding override playback', () => {
    const bindingSource = provenance('artifact-old');
    const accepted = provenance('artifact-current');
    const result = playback({
      acceptedSpeakerProvenance: [accepted],
      voiceBindings: [binding(bindingSource.id)],
    });

    expect(result).toMatchObject({
      speakerProvenanceId: accepted.id,
      voiceProfileId: existingProfile.id,
      voiceURI: existingProfile.providerVoiceId,
    });
    expect(result.voiceIdentityId).toBeUndefined();
    expect(result.voiceAssignmentRevision).toBeUndefined();
  });

  it('does not let a stale provenance binding override playback', () => {
    const accepted = provenance('artifact-stale');
    const stale = transitionAcceptedSpeakerProvenance(accepted, 'stale', 'source revision changed');
    const result = playback({
      acceptedSpeakerProvenance: [stale],
      voiceBindings: [binding(accepted.id)],
    });

    expect(result).toMatchObject({
      voiceProfileId: existingProfile.id,
      voiceURI: existingProfile.providerVoiceId,
    });
    expect(result.speakerProvenanceId).toBeUndefined();
    expect(result.voiceIdentityId).toBeUndefined();
    expect(result.voiceAssignmentRevision).toBeUndefined();
  });
});
