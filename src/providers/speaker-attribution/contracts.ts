import type { SpeakerSpanType } from '@noveldesk/text-core/speaker-attribution';

import type { SpeakerContextEnvelopeV1 } from './speaker-context-envelope';

export const SCENE_SPEAKER_PACKET_VERSION = 'scene-speaker-packet-v6' as const;
export const SPEAKER_WIRE_VERSION = 2 as const;
export const SPEAKER_ATTRIBUTION_REQUEST_PROFILE_ID = 'speaker-attribution-v3-compact' as const;
export const SPEAKER_ATTRIBUTION_INPUT_PROTOCOL_VERSION = 'speaker-attribution-readable-v3' as const;
export const SPEAKER_ATTRIBUTION_PROMPT_VERSION = 'speaker-attributor-v11-grounded-candidates-v1' as const;
export const SPEAKER_ATTRIBUTION_SCHEMA_VERSION = 'speaker-wire-v2' as const;

export const SpeakerOrdinal = {
  narrator: 0,
  system: 1,
  unknown: 2,
  newFromMention: 3,
  firstCandidate: 4,
} as const;

export const SpeakerReviewBits = {
  lowConfidence: 1 << 0,
  unknownSpeaker: 1 << 1,
  multipleCandidates: 1 << 2,
  newEntity: 1 << 3,
  sequenceDisagreement: 1 << 4,
  temporalConflict: 1 << 5,
} as const;

export const SpeakerSpanTypeCode: Readonly<Record<SpeakerSpanType, number>> = {
  narration: 0,
  dialogue: 1,
  inner_monologue: 2,
  message: 3,
  system: 4,
  sfx: 5,
  metadata: 6,
  unknown: 7,
};

export interface SceneSpeakerPacketV6 {
  readonly version: 6;
  readonly contract: typeof SCENE_SPEAKER_PACKET_VERSION;
  readonly fingerprint: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly sceneId: string;
  readonly sourceRevision: string;
  readonly sourceManifestFingerprint: string;
  readonly spanInventoryHash: string;
  readonly mentionInventoryHash: string;
  readonly candidateMemoryHash: string;
  readonly temporalSnapshotId: string;
  readonly temporalSnapshotHash: string;
  readonly dialogueBurstInventoryHash: string;
  readonly sieveVersion: string;
  readonly correctionCursor: string;
  readonly mode: 'reader_safe' | 'omniscient_consistent' | 'streaming';
  readonly candidates: readonly (readonly [
    ordinal: number,
    speakerEntityId: string,
    display: string,
    evidenceBits: number,
  ])[];
  readonly candidateSourceAnchors: readonly (readonly [
    candidateOrdinal: number,
    mentionId: string,
    sceneId: string,
    paragraphId: string,
    paragraphIndex: number,
    spanId: string,
    spanIndex: number,
    startOffset: number,
    endOffset: number,
  ])[];
  readonly mentions: readonly (readonly [ordinal: number, surface: string, typeCode: number])[];
  readonly mentionSourceIds: readonly (readonly [ordinal: number, sourceMentionId: string])[];
  readonly newMentionOrdinalsByTarget: readonly (readonly [
    targetPosition: number,
    mentionOrdinals: readonly number[],
  ])[];
  readonly recentTurns: readonly (readonly [speakerOrdinal: number, text: string])[];
  readonly relationDictionary: readonly (readonly [relationCode: number, relationType: string])[];
  readonly relationHints: readonly (readonly [
    subjectOrdinal: number,
    relationCode: number,
    objectOrdinal: number,
    qualityCode: number,
  ])[];
  readonly dialogueBursts: readonly (readonly [
    burstOrdinal: number,
    targetSpanIndexes: readonly number[],
    candidatePoolOrdinals: readonly number[],
  ])[];
  readonly contextEnvelope: SpeakerContextEnvelopeV1;
  readonly targets: readonly (readonly [
    spanIndex: number,
    burstOrdinal: number,
    spanTypeCode: number,
    text: string,
    candidateOrdinals: readonly number[],
    evidenceBitsByCandidate: readonly number[],
  ])[];
  readonly ordinalDictionaryFingerprint: string;
}

/** @deprecated Kept as a source-compatible type alias while the persisted workflow job remains v3. */
export type SceneSpeakerPacketV5 = SceneSpeakerPacketV6;
/** @deprecated Kept as a source-compatible type alias while the persisted workflow job remains v3. */
export type SceneSpeakerPacketV4 = SceneSpeakerPacketV6;
/** @deprecated Kept as a source-compatible type alias while the persisted workflow job remains v3. */
export type SceneSpeakerPacketV3 = SceneSpeakerPacketV6;

export interface SpeakerWireV2 {
  readonly v: typeof SPEAKER_WIRE_VERSION;
  readonly f: string;
  readonly s: readonly number[];
  readonly q: readonly number[];
  readonly e: readonly number[];
  readonly u: readonly number[];
  readonly c: readonly (readonly number[])[];
  readonly r: readonly number[];
  readonly x: readonly (readonly [targetPosition: number, mentionOrdinal: number])[];
}

export interface SpeakerWireValidationIssueV1 {
  readonly severity: 'error' | 'review';
  readonly code: string;
  readonly targetPosition?: number;
  readonly detail: string;
}

export interface ValidatedSpeakerWireV2 {
  readonly wire: SpeakerWireV2;
  readonly issues: readonly SpeakerWireValidationIssueV1[];
  readonly reviewTargetPositions: readonly number[];
  readonly fingerprint: string;
}

export interface DialogueSequenceDecisionV1 {
  readonly version: 'dialogue-sequence-decision-v1';
  readonly id: string;
  readonly burstOrdinal: number;
  readonly spanIndexes: readonly number[];
  readonly candidateOrdinals: readonly (readonly number[])[];
  readonly selectedSpeakerOrdinals: readonly number[];
  readonly ruleConstraintBits: readonly number[];
  readonly decoderMethod: 'min_cost_path' | 'none';
  readonly disagreementIndexes: readonly number[];
  readonly reviewCodes: readonly number[];
  readonly fingerprint: string;
}
