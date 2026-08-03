import type { AcceptedSpeakerProvenanceV1 } from '../speaker-attribution/accepted-speaker-provenance';
import { assertAcceptedSpeakerProvenance } from '../speaker-attribution/accepted-speaker-provenance';
import { compareText, voiceCastingIdentity } from './artifact';
import type { AcceptedSpeakerUtteranceV1, CharacterImportanceProfileV1, VoiceTierV1 } from './contracts';
import { VOICE_CASTING_VERSION } from './contracts';

export interface AcceptedSpeakerUtteranceProjectionInputV1 {
  readonly provenance: AcceptedSpeakerProvenanceV1;
  readonly sourceStartOffset: number;
  readonly sourceEndOffset: number;
  readonly spokenCharacterCount: number;
}

export interface CharacterImportanceSignalV1 {
  readonly speakerEntityId: string;
  readonly namedIdentity?: boolean;
  readonly majorRelation?: boolean;
  readonly userPinned?: boolean;
}

export interface CharacterImportancePolicyV1 {
  readonly weights: {
    readonly spokenCharacterCount: number;
    readonly utteranceCount: number;
    readonly distinctSpeakingScenes: number;
    readonly distinctSpeakingChapters: number;
    readonly recurrenceOrderSpan: number;
    readonly namedIdentity: number;
    readonly majorRelation: number;
    readonly userPinned: number;
  };
  readonly tierMinimumScore: Readonly<Record<'A' | 'B' | 'C', number>>;
  readonly forceAForMajorRelation: boolean;
  readonly forceAForUserPinned: boolean;
}

export const DEFAULT_CHARACTER_IMPORTANCE_POLICY_V1: CharacterImportancePolicyV1 = {
  weights: {
    spokenCharacterCount: 0.01,
    utteranceCount: 1,
    distinctSpeakingScenes: 3,
    distinctSpeakingChapters: 5,
    recurrenceOrderSpan: 0.01,
    namedIdentity: 8,
    majorRelation: 20,
    userPinned: 30,
  },
  tierMinimumScore: { A: 45, B: 18, C: 4 },
  forceAForMajorRelation: true,
  forceAForUserPinned: true,
};

export function isVoiceCastableSpeakerUtterance(utterance: AcceptedSpeakerUtteranceV1): boolean {
  return (
    utterance.status === 'active' &&
    utterance.canonicalSpeakerId !== 'narrator' &&
    utterance.canonicalSpeakerId !== 'system' &&
    utterance.speakerEntityId !== 'narrator' &&
    utterance.speakerEntityId !== 'system'
  );
}

function assertNonnegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer`);
}

export function projectAcceptedSpeakerUtterance(
  input: AcceptedSpeakerUtteranceProjectionInputV1,
): AcceptedSpeakerUtteranceV1 {
  assertAcceptedSpeakerProvenance(input.provenance);
  assertNonnegativeSafeInteger(input.sourceStartOffset, 'sourceStartOffset');
  assertNonnegativeSafeInteger(input.sourceEndOffset, 'sourceEndOffset');
  assertNonnegativeSafeInteger(input.spokenCharacterCount, 'spokenCharacterCount');
  if (input.sourceEndOffset < input.sourceStartOffset)
    throw new Error('sourceEndOffset must not precede sourceStartOffset');

  const provenance = input.provenance;
  const speakerEntityId = provenance.speakerEntityId ?? `unknown:${provenance.id}`;
  const core = {
    version: VOICE_CASTING_VERSION,
    bookId: provenance.bookId,
    contentRevisionId: provenance.contentRevisionId,
    chapterId: provenance.chapterId,
    paragraphId: provenance.paragraphId,
    segmentId: provenance.segmentId,
    acceptedProvenanceId: provenance.id,
    acceptedProvenanceFingerprint: provenance.fingerprint,
    sourceSpanId: provenance.sourceSpanId,
    sourceStartOffset: input.sourceStartOffset,
    sourceEndOffset: input.sourceEndOffset,
    sceneId: provenance.sceneId,
    dialogueBurstId: provenance.dialogueBurstId,
    narrativeOrder: provenance.narrativeOrder,
    readerStateSnapshotId: provenance.temporalSnapshotId,
    dialogueSequenceDecisionId: provenance.sequenceDecisionId,
    speakerEntityId,
    canonicalSpeakerId: provenance.canonicalSpeakerId,
    spokenCharacterCount: input.spokenCharacterCount,
  };
  return {
    ...core,
    ...voiceCastingIdentity('accepted_speaker_utterance', core),
    status: provenance.status,
  };
}

interface ImportanceAccumulator {
  readonly utterances: AcceptedSpeakerUtteranceV1[];
  readonly sceneIds: Set<string>;
  readonly chapterIds: Set<string>;
  spokenCharacterCount: number;
}

function tierForScore(
  score: number,
  signal: Required<Omit<CharacterImportanceSignalV1, 'speakerEntityId'>>,
  policy: CharacterImportancePolicyV1,
): VoiceTierV1 {
  if ((signal.userPinned && policy.forceAForUserPinned) || (signal.majorRelation && policy.forceAForMajorRelation)) {
    return 'A_dedicated';
  }
  if (score >= policy.tierMinimumScore.A) return 'A_dedicated';
  if (score >= policy.tierMinimumScore.B) return 'B_stable_pool';
  if (score >= policy.tierMinimumScore.C) return 'C_scene_pool';
  return 'D_fallback';
}

function validatePolicy(policy: CharacterImportancePolicyV1): void {
  for (const [key, value] of Object.entries(policy.weights)) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`Importance weight ${key} must be finite and nonnegative`);
  }
  const { A, B, C } = policy.tierMinimumScore;
  if (![A, B, C].every(Number.isFinite) || A < B || B < C) {
    throw new Error('Importance tier thresholds must be finite and ordered A >= B >= C');
  }
}

export function aggregateCharacterImportance(input: {
  readonly utterances: readonly AcceptedSpeakerUtteranceV1[];
  readonly mode: 'full_file' | 'streaming';
  readonly policy?: CharacterImportancePolicyV1;
  readonly signals?: readonly CharacterImportanceSignalV1[];
}): readonly CharacterImportanceProfileV1[] {
  const policy = input.policy ?? DEFAULT_CHARACTER_IMPORTANCE_POLICY_V1;
  validatePolicy(policy);
  const signals = new Map((input.signals ?? []).map((signal) => [signal.speakerEntityId, signal]));
  const grouped = new Map<string, ImportanceAccumulator>();

  for (const utterance of input.utterances) {
    if (!isVoiceCastableSpeakerUtterance(utterance)) continue;
    const group = grouped.get(utterance.speakerEntityId) ?? {
      utterances: [],
      sceneIds: new Set<string>(),
      chapterIds: new Set<string>(),
      spokenCharacterCount: 0,
    };
    group.utterances.push(utterance);
    group.sceneIds.add(utterance.sceneId);
    group.chapterIds.add(utterance.chapterId);
    group.spokenCharacterCount += utterance.spokenCharacterCount;
    grouped.set(utterance.speakerEntityId, group);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([speakerEntityId, group]) => {
      const utterances = [...group.utterances].sort(
        (left, right) => left.narrativeOrder - right.narrativeOrder || compareText(left.id, right.id),
      );
      const first = utterances[0]!;
      const last = utterances[utterances.length - 1]!;
      const supplied = signals.get(speakerEntityId);
      const signal = {
        namedIdentity: supplied?.namedIdentity ?? false,
        majorRelation: supplied?.majorRelation ?? false,
        userPinned: supplied?.userPinned ?? false,
      };
      const recurrenceOrderSpan = last.narrativeOrder - first.narrativeOrder;
      const weight = policy.weights;
      const importanceScore =
        group.spokenCharacterCount * weight.spokenCharacterCount +
        utterances.length * weight.utteranceCount +
        group.sceneIds.size * weight.distinctSpeakingScenes +
        group.chapterIds.size * weight.distinctSpeakingChapters +
        recurrenceOrderSpan * weight.recurrenceOrderSpan +
        Number(signal.namedIdentity) * weight.namedIdentity +
        Number(signal.majorRelation) * weight.majorRelation +
        Number(signal.userPinned) * weight.userPinned;
      const core = {
        version: VOICE_CASTING_VERSION,
        bookId: first.bookId,
        contentRevisionId: first.contentRevisionId,
        speakerEntityId,
        effectiveFromOrder: first.narrativeOrder,
        effectiveToOrder: last.narrativeOrder,
        effectiveFromSceneId: first.sceneId,
        effectiveToSceneId: last.sceneId,
        spokenCharacterCount: group.spokenCharacterCount,
        utteranceCount: utterances.length,
        distinctSpeakingScenes: group.sceneIds.size,
        distinctSpeakingChapters: group.chapterIds.size,
        firstSpeakingOrder: first.narrativeOrder,
        lastSpeakingOrder: last.narrativeOrder,
        ...signal,
        importanceScore,
        voiceTier: tierForScore(importanceScore, signal, policy),
        mode: input.mode,
      };
      return {
        ...core,
        ...voiceCastingIdentity('character_importance_profile', core),
        status: 'active' as const,
      };
    });
}
