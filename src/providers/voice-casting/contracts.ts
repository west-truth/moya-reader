import type { VoiceProfile } from '../../domain/types';

export const VOICE_CASTING_VERSION = 'voice-casting-v1' as const;

export type VoiceTierV1 = 'A_dedicated' | 'B_stable_pool' | 'C_scene_pool' | 'D_fallback';
export type VoiceCastingArtifactStatusV1 = 'active' | 'superseded' | 'stale';

export interface NarrativeIntervalV1 {
  readonly effectiveFromOrder: number;
  readonly effectiveToOrder?: number;
  readonly effectiveFromSceneId: string;
  readonly effectiveToSceneId?: string;
}

export interface ImmutableVoiceCastingArtifactV1 {
  readonly version: typeof VOICE_CASTING_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly revision: string;
  readonly fingerprint: string;
}

export interface AcceptedSpeakerUtteranceV1 extends ImmutableVoiceCastingArtifactV1 {
  readonly chapterId: string;
  readonly paragraphId: string;
  readonly segmentId: string;
  readonly acceptedProvenanceId: string;
  readonly acceptedProvenanceFingerprint: string;
  readonly sourceSpanId: string;
  readonly sourceStartOffset: number;
  readonly sourceEndOffset: number;
  readonly sceneId: string;
  readonly dialogueBurstId?: string;
  readonly narrativeOrder: number;
  readonly readerStateSnapshotId?: string;
  readonly dialogueSequenceDecisionId?: string;
  readonly speakerEntityId: string;
  readonly canonicalSpeakerId: string;
  readonly spokenCharacterCount: number;
  readonly status: VoiceCastingArtifactStatusV1;
}

export interface CharacterImportanceProfileV1 extends ImmutableVoiceCastingArtifactV1, NarrativeIntervalV1 {
  readonly speakerEntityId: string;
  readonly spokenCharacterCount: number;
  readonly utteranceCount: number;
  readonly distinctSpeakingScenes: number;
  readonly distinctSpeakingChapters: number;
  readonly firstSpeakingOrder: number;
  readonly lastSpeakingOrder: number;
  readonly namedIdentity: boolean;
  readonly majorRelation: boolean;
  readonly userPinned: boolean;
  readonly importanceScore: number;
  readonly voiceTier: VoiceTierV1;
  readonly mode: 'full_file' | 'streaming';
  readonly status: VoiceCastingArtifactStatusV1;
}

export type VoiceGenderPresentationV1 = 'masculine' | 'feminine' | 'androgynous' | 'unknown';
export type VoiceAgeBandV1 = 'child' | 'adolescent' | 'young_adult' | 'adult' | 'older_adult' | 'elderly' | 'unknown';
export type VoiceVocalWeightV1 = 'light' | 'medium' | 'heavy' | 'unknown';
export type VoiceRegisterV1 = 'casual' | 'polite' | 'formal' | 'rough' | 'neutral' | 'unknown';

export interface VoiceTraitValuesV1 {
  readonly genderPresentation: VoiceGenderPresentationV1;
  readonly ageBand: VoiceAgeBandV1;
  readonly vocalWeight: VoiceVocalWeightV1;
  readonly registerDefault: VoiceRegisterV1;
}

export interface VoiceTraitEvidenceV1 extends ImmutableVoiceCastingArtifactV1 {
  readonly speakerEntityId: string;
  readonly sceneId: string;
  readonly narrativeOrder: number;
  readonly evidenceSpanId: string;
  readonly evidenceKind: 'name_only' | 'source_rule' | 'llm_micro_pass' | 'user';
  readonly proposedTraits: Partial<VoiceTraitValuesV1>;
  readonly confidence: number;
  readonly status: VoiceCastingArtifactStatusV1;
  readonly userPinned: boolean;
}

export interface VoiceTraitProfileV1 extends ImmutableVoiceCastingArtifactV1, NarrativeIntervalV1, VoiceTraitValuesV1 {
  readonly speakerEntityId: string;
  readonly storyTimeBucket?: string;
  readonly confidence: number;
  readonly evidenceSpanIds: readonly string[];
  readonly provenance: readonly ('source_rule' | 'llm_micro_pass' | 'user')[];
  readonly status: VoiceCastingArtifactStatusV1;
  readonly userPinned: boolean;
}

export interface VoiceTraitMicroPassCandidateV1 {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly speakerEntityId: string;
  readonly profileRevision: string;
  readonly unresolvedTraits: readonly (keyof VoiceTraitValuesV1)[];
  readonly evidenceSpanIds: readonly string[];
}

export interface VoicePoolDefinitionV1 extends ImmutableVoiceCastingArtifactV1 {
  readonly providerId: string;
  readonly providerModel?: string;
  readonly key: string;
  readonly voiceProfileIds: readonly string[];
  readonly traitFilter: Partial<Pick<VoiceTraitProfileV1, 'genderPresentation' | 'ageBand' | 'vocalWeight'>>;
  readonly narratorExcluded: boolean;
  readonly status: VoiceCastingArtifactStatusV1;
  readonly userPinned: boolean;
}

export interface VoicePoolAssignmentV1 extends ImmutableVoiceCastingArtifactV1, NarrativeIntervalV1 {
  readonly speakerEntityId: string;
  readonly voiceIdentityId: string;
  readonly voiceTier: VoiceTierV1;
  readonly voicePoolKey?: string;
  readonly voiceProfileId: string;
  readonly actualVoiceKey: string;
  readonly method: 'dedicated' | 'stable_hash' | 'min_cost_matching' | 'user';
  readonly collisionSetId?: string;
  readonly promotionFromAssignmentId?: string;
  readonly retroactiveRerender: boolean;
  readonly status: VoiceCastingArtifactStatusV1;
  readonly userPinned: boolean;
}

export interface VoiceAssignmentOverrideV1 extends ImmutableVoiceCastingArtifactV1, NarrativeIntervalV1 {
  readonly speakerEntityId: string;
  readonly voiceIdentityId: string;
  readonly voiceProfileId: string;
  readonly reasonCode: 'user_selection' | 'accessibility' | 'continuity' | 'narrator_separation';
  readonly status: VoiceCastingArtifactStatusV1;
  readonly userPinned: true;
}

export type VoiceCastingReviewKindV1 =
  'voice_pool_capacity' | 'voice_pin_conflict' | 'missing_dedicated_voice' | 'missing_voice_profile' | 'identity_merge';

export interface VoiceCastingReviewV1 extends ImmutableVoiceCastingArtifactV1, NarrativeIntervalV1 {
  readonly kind: VoiceCastingReviewKindV1;
  readonly speakerEntityIds: readonly string[];
  readonly voicePoolKey?: string;
  readonly voiceProfileIds: readonly string[];
  readonly assignmentIds: readonly string[];
  readonly status: 'open' | 'resolved' | 'dismissed';
  readonly userPinned: boolean;
}

export interface VoiceCastingStateV1 extends ImmutableVoiceCastingArtifactV1 {
  readonly importanceRevision: string;
  readonly traitRevision: string;
  readonly poolRevision: string;
  readonly voiceProfileRevision: string;
  readonly assignmentRevision: string;
  readonly assignments: readonly VoicePoolAssignmentV1[];
  readonly reviews: readonly VoiceCastingReviewV1[];
  readonly status: 'staging' | 'active' | 'stale';
  readonly userPinned: boolean;
}

export interface VoiceCastingWorkspaceUserArtifactsV1 {
  readonly voiceProfileIds: readonly string[];
  readonly pools: readonly VoicePoolDefinitionV1[];
  readonly overrides: readonly VoiceAssignmentOverrideV1[];
  readonly traitEvidence: readonly VoiceTraitEvidenceV1[];
}

export interface VoiceCastingWorkspaceDerivedArtifactsV1 {
  readonly utterances: readonly AcceptedSpeakerUtteranceV1[];
  readonly importanceProfiles: readonly CharacterImportanceProfileV1[];
  readonly traitEvidence: readonly VoiceTraitEvidenceV1[];
  readonly traitProfiles: readonly VoiceTraitProfileV1[];
  readonly pools: readonly VoicePoolDefinitionV1[];
  readonly state: VoiceCastingStateV1;
}

export interface VoiceCastingWorkspaceV1 extends ImmutableVoiceCastingArtifactV1 {
  readonly storageRevision: number;
  readonly userArtifacts: VoiceCastingWorkspaceUserArtifactsV1;
  readonly derivedArtifacts: VoiceCastingWorkspaceDerivedArtifactsV1;
  readonly status: 'active' | 'stale';
  readonly userPinned: boolean;
}

export interface TtsVoiceBindingV1 {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly paragraphId: string;
  readonly segmentId: string;
  readonly acceptedProvenanceId: string;
  readonly speakerEntityId: string;
  readonly sceneId: string;
  readonly dialogueBurstId?: string;
  readonly narrativeOrder: number;
  readonly readerStateSnapshotId?: string;
  readonly dialogueSequenceDecisionId?: string;
  readonly voiceIdentityId: string;
  readonly voiceProfileId: string;
  readonly voiceProfile: VoiceProfile;
  readonly voiceTier: VoiceTierV1;
  readonly voicePoolKey?: string;
  readonly voiceAssignmentRevision: string;
}

export interface VoiceCastingRecomputeChangeV1 {
  readonly kind: 'pool' | 'trait' | 'voice_profile' | 'assignment_override' | 'speaker_label' | 'source';
  readonly artifactId: string;
  readonly revision: string;
  readonly speakerEntityIds?: readonly string[];
  readonly scopeStartOrder?: number;
  readonly scopeEndOrder?: number;
}

export interface VoiceCastingRecomputePlanV1 {
  readonly level: 'L4_voice' | 'L3_speaker' | 'L0_source';
  readonly invalidateVoiceAssignments: boolean;
  readonly invalidateTts: boolean;
  readonly recallSpeakerProvider: boolean;
  readonly affectedSpeakerEntityIds: readonly string[];
  readonly changedArtifactIds: readonly string[];
  readonly scopeStartOrder?: number;
  readonly scopeEndOrder?: number;
  readonly fingerprint: string;
}
