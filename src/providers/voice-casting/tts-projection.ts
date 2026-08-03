import type { VoiceProfile } from '../../domain/types';
import { compareText, includesNarrativeOrder } from './artifact';
import type { AcceptedSpeakerUtteranceV1, TtsVoiceBindingV1, VoicePoolAssignmentV1 } from './contracts';
import { actualProviderVoiceKey } from './pools';

export interface TtsVoiceProjectionResultV1 {
  readonly bindings: readonly TtsVoiceBindingV1[];
  readonly unresolvedSegmentIds: readonly string[];
}

export function resolveTtsVoiceBindings(input: {
  readonly utterances: readonly AcceptedSpeakerUtteranceV1[];
  readonly assignments: readonly VoicePoolAssignmentV1[];
  readonly voiceProfiles: readonly VoiceProfile[];
  readonly providerId?: string;
  readonly providerModel?: string;
}): TtsVoiceProjectionResultV1 {
  const profiles = new Map(input.voiceProfiles.map((profile) => [profile.id, profile]));
  const bindings: TtsVoiceBindingV1[] = [];
  const unresolvedSegmentIds: string[] = [];
  const utterances = input.utterances
    .filter((utterance) => utterance.status === 'active')
    .sort((left, right) => left.narrativeOrder - right.narrativeOrder || compareText(left.id, right.id));

  for (const utterance of utterances) {
    const assignment = input.assignments
      .filter(
        (candidate) =>
          candidate.status === 'active' &&
          candidate.bookId === utterance.bookId &&
          candidate.contentRevisionId === utterance.contentRevisionId &&
          candidate.speakerEntityId === utterance.speakerEntityId &&
          (input.providerId === undefined || profiles.get(candidate.voiceProfileId)?.providerId === input.providerId) &&
          (input.providerModel === undefined ||
            profiles.get(candidate.voiceProfileId)?.providerModel === input.providerModel) &&
          includesNarrativeOrder(candidate, utterance.narrativeOrder),
      )
      .sort(
        (left, right) =>
          Number(right.userPinned) - Number(left.userPinned) ||
          right.effectiveFromOrder - left.effectiveFromOrder ||
          compareText(left.id, right.id),
      )[0];
    const profile = assignment ? profiles.get(assignment.voiceProfileId) : undefined;
    if (
      !assignment ||
      !profile ||
      profile.novelId !== utterance.bookId ||
      assignment.actualVoiceKey !== actualProviderVoiceKey(profile)
    ) {
      unresolvedSegmentIds.push(utterance.segmentId);
      continue;
    }
    bindings.push({
      bookId: utterance.bookId,
      contentRevisionId: utterance.contentRevisionId,
      chapterId: utterance.chapterId,
      paragraphId: utterance.paragraphId,
      segmentId: utterance.segmentId,
      acceptedProvenanceId: utterance.acceptedProvenanceId,
      speakerEntityId: utterance.speakerEntityId,
      sceneId: utterance.sceneId,
      dialogueBurstId: utterance.dialogueBurstId,
      narrativeOrder: utterance.narrativeOrder,
      readerStateSnapshotId: utterance.readerStateSnapshotId,
      dialogueSequenceDecisionId: utterance.dialogueSequenceDecisionId,
      voiceIdentityId: assignment.voiceIdentityId,
      voiceProfileId: assignment.voiceProfileId,
      voiceProfile: profile,
      voiceTier: assignment.voiceTier,
      voicePoolKey: assignment.voicePoolKey,
      voiceAssignmentRevision: assignment.revision,
    });
  }
  return { bindings, unresolvedSegmentIds: unresolvedSegmentIds.sort(compareText) };
}
