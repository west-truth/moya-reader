import type { VoiceProfile } from '../../domain/types';
import { describe, expect, it } from 'vitest';
import { createAcceptedSpeakerProvenance } from '../speaker-attribution/accepted-speaker-provenance';
import {
  aggregateCharacterImportance,
  assertVoiceCastingWorkspace,
  computeVoiceCastingState,
  computeVoiceTraitProfiles,
  createEmptyVoiceCastingWorkspace,
  createVoiceAssignmentOverride,
  createVoicePoolDefinition,
  findVoiceCollisions,
  normalizeVoiceCastingWorkspace,
  planVoiceCastingRecompute,
  projectAcceptedSpeakerUtterance,
  recomputeVoiceCastingState,
  resolveTtsVoiceBindings,
  validateVoicePools,
  type AcceptedSpeakerUtteranceV1,
  type CharacterImportanceProfileV1,
  type VoicePoolDefinitionV1,
  type VoiceTraitProfileV1,
} from './index';

const voices: readonly VoiceProfile[] = [
  {
    id: 'voice-a',
    novelId: 'book-1',
    role: 'unknown',
    providerId: 'provider-1',
    providerModel: 'model-1',
    providerVoiceId: 'actual-a',
    label: 'A',
    speed: 1,
    isUserSelected: true,
  },
  {
    id: 'voice-b',
    novelId: 'book-1',
    role: 'unknown',
    providerId: 'provider-1',
    providerModel: 'model-1',
    providerVoiceId: 'actual-b',
    label: 'B',
    speed: 1,
    isUserSelected: true,
  },
];

function utterance(
  speakerEntityId: string,
  order: number,
  sceneId = 'scene-1',
  dialogueBurstId = `burst-${sceneId}`,
): AcceptedSpeakerUtteranceV1 {
  const provenance = createAcceptedSpeakerProvenance(
    {
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      chapterId: 'chapter-1',
      paragraphId: `paragraph-${order}`,
      segmentId: `segment-${order}`,
      sourceSpanId: `span-${order}`,
      sceneId,
      dialogueBurstId,
      narrativeOrder: order,
      speakerEntityId,
      canonicalSpeakerId: speakerEntityId,
      resolutionKind: 'deterministic',
      sourceManifestFingerprint: 'manifest-1',
      confidence: 0.9,
    },
    'artifact-1',
    '2026-07-13T00:00:00.000Z',
  );
  return projectAcceptedSpeakerUtterance({
    provenance,
    sourceStartOffset: 0,
    sourceEndOffset: 20,
    spokenCharacterCount: 20,
  });
}

function pool(profileIds: readonly string[] = ['voice-a', 'voice-b']): VoicePoolDefinitionV1 {
  return createVoicePoolDefinition({
    bookId: 'book-1',
    contentRevisionId: 'content-1',
    providerId: 'provider-1',
    providerModel: 'model-1',
    key: 'neutral',
    voiceProfileIds: profileIds,
    traitFilter: {},
    narratorExcluded: true,
    status: 'active',
    userPinned: true,
  });
}

function domain(utterances: readonly AcceptedSpeakerUtteranceV1[]): {
  readonly importanceProfiles: readonly CharacterImportanceProfileV1[];
  readonly traitProfiles: readonly VoiceTraitProfileV1[];
} {
  const importanceProfiles = aggregateCharacterImportance({ utterances, mode: 'full_file' });
  return { importanceProfiles, traitProfiles: computeVoiceTraitProfiles({ importanceProfiles, evidence: [] }) };
}

describe('voice pool allocation and state', () => {
  it('validates actual provider/model/voice collisions instead of profile ids', () => {
    const duplicate: VoiceProfile = { ...voices[1]!, id: 'voice-c', providerVoiceId: 'actual-a' };
    const result = validateVoicePools({ pools: [pool(['voice-a', 'voice-c'])], voiceProfiles: [...voices, duplicate] });

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'duplicate_actual_voice')).toBe(true);
  });

  it('defensively excludes narrator and system rows from allocation', () => {
    const narrator = utterance('narrator', 1);
    const character = utterance('speaker-a', 2);
    const characterDomain = domain([character]);
    const narratorImportance = {
      ...characterDomain.importanceProfiles[0]!,
      speakerEntityId: 'narrator',
    };
    const state = computeVoiceCastingState({
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      utterances: [narrator],
      importanceProfiles: [narratorImportance],
      traitProfiles: [],
      pools: [pool()],
      voiceProfiles: voices,
    });

    expect(state.assignments).toEqual([]);
    expect(state.reviews).toEqual([]);
  });

  it('is order-independent and avoids same scene and burst collisions', () => {
    const utterances = [utterance('speaker-b', 2), utterance('speaker-a', 1)];
    const { importanceProfiles, traitProfiles } = domain(utterances);
    const first = computeVoiceCastingState({
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      utterances,
      importanceProfiles,
      traitProfiles,
      pools: [pool()],
      voiceProfiles: voices,
    });
    const second = computeVoiceCastingState({
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      utterances: [...utterances].reverse(),
      importanceProfiles: [...importanceProfiles].reverse(),
      traitProfiles: [...traitProfiles].reverse(),
      pools: [pool()],
      voiceProfiles: [...voices].reverse(),
    });

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(findVoiceCollisions({ utterances, assignments: first.assignments })).toEqual([]);
    expect(new Set(first.assignments.map((assignment) => assignment.actualVoiceKey)).size).toBe(2);
  });

  it('opens a capacity review instead of silently duplicating an insufficient pool', () => {
    const utterances = [utterance('speaker-a', 1), utterance('speaker-b', 2)];
    const { importanceProfiles, traitProfiles } = domain(utterances);
    const state = computeVoiceCastingState({
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      utterances,
      importanceProfiles,
      traitProfiles,
      pools: [pool(['voice-a'])],
      voiceProfiles: voices,
    });

    expect(state.reviews.some((review) => review.kind === 'voice_pool_capacity')).toBe(true);
    expect(state.assignments).toEqual([]);
  });

  it('keeps solvable collision components when an independent burst lacks capacity', () => {
    const utterances = [
      utterance('speaker-a', 1, 'scene-1', 'burst-1'),
      utterance('speaker-b', 2, 'scene-1', 'burst-1'),
      utterance('speaker-c', 3, 'scene-2', 'burst-2'),
    ];
    const { importanceProfiles, traitProfiles } = domain(utterances);
    const state = computeVoiceCastingState({
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      utterances,
      importanceProfiles,
      traitProfiles,
      pools: [pool(['voice-a'])],
      voiceProfiles: voices,
    });

    expect(state.assignments.map((assignment) => assignment.speakerEntityId)).toEqual(['speaker-c']);
    expect(state.reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'voice_pool_capacity', speakerEntityIds: ['speaker-a', 'speaker-b'] }),
      ]),
    );
  });

  it('treats scene-wide reuse as a soft cost while keeping dialogue bursts hard', () => {
    const utterances = [
      utterance('speaker-a', 1, 'scene-1', 'burst-1'),
      utterance('speaker-b', 2, 'scene-1', 'burst-2'),
    ];
    const { importanceProfiles, traitProfiles } = domain(utterances);
    const roomy = computeVoiceCastingState({
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      utterances,
      importanceProfiles,
      traitProfiles,
      pools: [pool()],
      voiceProfiles: voices,
    });
    const constrained = computeVoiceCastingState({
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      utterances,
      importanceProfiles,
      traitProfiles,
      pools: [pool(['voice-a'])],
      voiceProfiles: voices,
    });

    expect(findVoiceCollisions({ utterances, assignments: roomy.assignments })).toEqual([]);
    expect(constrained.assignments).toHaveLength(2);
    expect(constrained.reviews.some((review) => review.kind === 'voice_pool_capacity')).toBe(false);
    expect(findVoiceCollisions({ utterances, assignments: constrained.assignments })).toHaveLength(1);
  });

  it('makes open-ended capacity review intervals deterministic', () => {
    const utterances = [utterance('speaker-a', 1), utterance('speaker-b', 2)];
    const base = domain(utterances);
    const importanceProfiles = base.importanceProfiles.map((profile) => ({ ...profile, effectiveToOrder: undefined }));
    const compute = (profiles: readonly CharacterImportanceProfileV1[]) =>
      computeVoiceCastingState({
        bookId: 'book-1',
        contentRevisionId: 'content-1',
        utterances,
        importanceProfiles: profiles,
        traitProfiles: base.traitProfiles,
        pools: [pool(['voice-a'])],
        voiceProfiles: voices,
      });

    const first = compute(importanceProfiles);
    const second = compute([...importanceProfiles].reverse());
    expect(first.reviews[0]!.effectiveToOrder).toBeUndefined();
    expect(second.reviews[0]!.fingerprint).toBe(first.reviews[0]!.fingerprint);
  });

  it('preserves a user pin across a pool revision that removes the pinned voice', () => {
    const utterances = [utterance('speaker-a', 1)];
    const { importanceProfiles, traitProfiles } = domain(utterances);
    const override = createVoiceAssignmentOverride({
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      speakerEntityId: 'speaker-a',
      voiceIdentityId: 'identity-user-a',
      voiceProfileId: 'voice-a',
      reasonCode: 'user_selection',
      effectiveFromOrder: 1,
      effectiveToOrder: 100,
      effectiveFromSceneId: 'scene-1',
      status: 'active',
    });
    const state = computeVoiceCastingState({
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      utterances,
      importanceProfiles,
      traitProfiles,
      pools: [pool(['voice-b'])],
      voiceProfiles: voices,
      overrides: [override],
    });

    expect(state.assignments).toHaveLength(1);
    expect(state.assignments[0]).toMatchObject({ voiceProfileId: 'voice-a', userPinned: true, method: 'user' });
  });

  it('preserves the old interval and creates a forward-only promotion assignment', () => {
    const utterances = [utterance('speaker-a', 1)];
    const { importanceProfiles, traitProfiles } = domain(utterances);
    const first = computeVoiceCastingState({
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      utterances,
      importanceProfiles,
      traitProfiles,
      pools: [pool()],
      voiceProfiles: voices,
    });
    const prior = first.assignments[0]!;
    const dedicatedProfileId = prior.voiceProfileId === 'voice-a' ? 'voice-b' : 'voice-a';
    const promoted = computeVoiceCastingState({
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      utterances,
      importanceProfiles: importanceProfiles.map((profile) => ({ ...profile, voiceTier: 'A_dedicated' as const })),
      traitProfiles,
      pools: [pool()],
      voiceProfiles: voices,
      existingAssignments: first.assignments,
      dedicatedVoiceProfileIdsBySpeakerEntityId: { 'speaker-a': [dedicatedProfileId] },
      forwardOnlyFromOrder: 10,
    });
    const next = promoted.assignments.find((assignment) => assignment.id !== prior.id)!;

    expect(promoted.assignments).toContainEqual(prior);
    expect(next).toMatchObject({
      effectiveFromOrder: 10,
      effectiveToOrder: undefined,
      promotionFromAssignmentId: prior.id,
      retroactiveRerender: false,
      method: 'dedicated',
    });
  });

  it('projects accepted provenance and assignment to TTS without a legacy fallback', () => {
    const assignedUtterance = utterance('speaker-a', 1);
    const unresolvedUtterance = utterance('speaker-z', 2, 'scene-2');
    const { importanceProfiles, traitProfiles } = domain([assignedUtterance]);
    const state = computeVoiceCastingState({
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      utterances: [assignedUtterance],
      importanceProfiles,
      traitProfiles,
      pools: [pool()],
      voiceProfiles: voices,
    });
    const projection = resolveTtsVoiceBindings({
      utterances: [assignedUtterance, unresolvedUtterance],
      assignments: state.assignments,
      voiceProfiles: voices,
    });

    expect(projection.bindings).toHaveLength(1);
    expect(projection.bindings[0]).toMatchObject({
      segmentId: assignedUtterance.segmentId,
      acceptedProvenanceId: assignedUtterance.acceptedProvenanceId,
      voiceAssignmentRevision: state.assignments[0]!.revision,
    });
    expect(projection.unresolvedSegmentIds).toEqual([unresolvedUtterance.segmentId]);

    const wrongProvider = resolveTtsVoiceBindings({
      utterances: [assignedUtterance],
      assignments: state.assignments,
      voiceProfiles: voices,
      providerId: 'hosted-provider',
    });
    expect(wrongProvider.bindings).toEqual([]);
    expect(wrongProvider.unresolvedSegmentIds).toEqual([assignedUtterance.segmentId]);

    const assignedProfileId = state.assignments[0]!.voiceProfileId;
    const changedProfile = resolveTtsVoiceBindings({
      utterances: [assignedUtterance],
      assignments: state.assignments,
      voiceProfiles: voices.map((profile) =>
        profile.id === assignedProfileId ? { ...profile, providerVoiceId: 'changed-after-assignment' } : profile,
      ),
    });
    expect(changedProfile.bindings).toEqual([]);
    expect(changedProfile.unresolvedSegmentIds).toEqual([assignedUtterance.segmentId]);
  });

  it('keeps clean compute and local voice-only recompute equivalent without speaker recall', () => {
    const utterances = [utterance('speaker-a', 1), utterance('speaker-b', 2)];
    const { importanceProfiles, traitProfiles } = domain(utterances);
    const casting = {
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      utterances,
      importanceProfiles,
      traitProfiles,
      pools: [pool()],
      voiceProfiles: voices,
    };
    const clean = computeVoiceCastingState(casting);
    const local = recomputeVoiceCastingState({
      casting,
      changes: [{ kind: 'pool', artifactId: 'pool-change', revision: 'pool-revision-2' }],
    });

    expect(local.state.fingerprint).toBe(clean.fingerprint);
    expect(local.plan).toMatchObject({
      level: 'L4_voice',
      invalidateVoiceAssignments: true,
      invalidateTts: true,
      recallSpeakerProvider: false,
    });
    expect(
      planVoiceCastingRecompute([
        { kind: 'trait', artifactId: 'trait', revision: '2' },
        { kind: 'voice_profile', artifactId: 'profile', revision: '2' },
      ]).recallSpeakerProvider,
    ).toBe(false);
  });

  it('provides a canonical CAS workspace with strict user/derived separation', () => {
    const empty = createEmptyVoiceCastingWorkspace({
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      storageRevision: 7,
    });
    expect(() => assertVoiceCastingWorkspace(empty)).not.toThrow();
    expect(empty.storageRevision).toBe(7);

    const normalized = normalizeVoiceCastingWorkspace({
      bookId: empty.bookId,
      contentRevisionId: empty.contentRevisionId,
      storageRevision: 8,
      userArtifacts: empty.userArtifacts,
      derivedArtifacts: empty.derivedArtifacts,
    });
    expect(normalized.storageRevision).toBe(8);
    expect(normalized.revision).not.toBe(empty.revision);
    expect(() => assertVoiceCastingWorkspace({ ...normalized, unexpected: true })).toThrow(/unexpected fields/);
  });
});
