import { persistentId128 } from '@noveldesk/text-core/hash';
import type { Character, VoiceProfile } from '../../domain/types';
import { backfillCharacterGraphKnowledgeV2 } from '../../providers/character-graph-v2';
import { createAcceptedSpeakerProvenance } from '../../providers/speaker-attribution/accepted-speaker-provenance';
import {
  createEmptyVoiceCastingWorkspace,
  createVoicePoolDefinition,
  normalizeVoiceCastingWorkspace,
  projectAcceptedSpeakerUtterance,
  type AcceptedSpeakerUtteranceV1,
  type VoiceCastingWorkspaceV1,
} from '../../providers/voice-casting';
import { buildVoiceCatalogSnapshot } from '../../providers/voice-product';
import { describe, expect, it } from 'vitest';
import {
  buildVoiceCastingProductDraft,
  invalidateVoiceCastingWorkspace,
  replaceVoiceCastingPool,
  shouldPersistVoiceCastingDraft,
} from './voice-casting-product';

const BOOK_ID = 'book-s8';
const CONTENT_REVISION_ID = 'content-s8';
const PROVIDER_ID = 'system';
const MODEL_ID = 'system-v1';
const CREATED_AT = '2026-07-13T00:00:00.000Z';

const snapshot = buildVoiceCatalogSnapshot({
  novelId: BOOK_ID,
  providerId: PROVIDER_ID,
  modelId: MODEL_ID,
  source: 'system_discovery',
  capturedAt: CREATED_AT,
  voices: [
    { id: 'voice-a', label: 'Voice A', lang: 'en-US' },
    { id: 'voice-b', label: 'Voice B', lang: 'en-US' },
    { id: 'voice-c', label: 'Voice C', lang: 'en-US' },
    { id: 'voice-d', label: 'Voice D', lang: 'en-US' },
    { id: 'voice-e', label: 'Voice E', lang: 'en-US' },
    { id: 'voice-f', label: 'Voice F', lang: 'en-US' },
  ],
});

function character(id: string, canonicalName = id): Character {
  return {
    id,
    novelId: BOOK_ID,
    canonicalName,
    aliases: [],
    color: '#336699',
    confidence: 1,
    isUserConfirmed: true,
  };
}

function utterance(input: {
  speakerEntityId: string;
  canonicalSpeakerId: string;
  order: number;
  chapterId?: string;
  sceneId?: string;
  dialogueBurstId?: string;
  spokenCharacterCount?: number;
}): AcceptedSpeakerUtteranceV1 {
  const chapterId = input.chapterId ?? 'chapter-1';
  const sceneId = input.sceneId ?? `scene-${input.order}`;
  const paragraphId = `paragraph-${input.order}`;
  const segmentId = `segment-${input.order}`;
  const provenance = createAcceptedSpeakerProvenance(
    {
      bookId: BOOK_ID,
      contentRevisionId: CONTENT_REVISION_ID,
      chapterId,
      paragraphId,
      segmentId,
      sourceSpanId: `span-${input.order}`,
      sceneId,
      dialogueBurstId: input.dialogueBurstId,
      narrativeOrder: input.order,
      speakerEntityId: input.speakerEntityId,
      canonicalSpeakerId: input.canonicalSpeakerId,
      resolutionKind: 'deterministic',
      sourceManifestFingerprint: 'manifest-s8',
      confidence: 0.98,
    },
    `artifact-${input.order}`,
    CREATED_AT,
  );
  const spokenCharacterCount = input.spokenCharacterCount ?? 20;
  return projectAcceptedSpeakerUtterance({
    provenance,
    sourceStartOffset: 0,
    sourceEndOffset: spokenCharacterCount,
    spokenCharacterCount,
  });
}

function sharedProfileId(voiceId: string): string {
  return persistentId128('voice_pool_profile', [BOOK_ID, PROVIDER_ID, MODEL_ID, voiceId]);
}

function pinnedProviderPoolWorkspace(): VoiceCastingWorkspaceV1 {
  const empty = createEmptyVoiceCastingWorkspace({
    bookId: BOOK_ID,
    contentRevisionId: CONTENT_REVISION_ID,
  });
  const pool = createVoicePoolDefinition({
    bookId: BOOK_ID,
    contentRevisionId: CONTENT_REVISION_ID,
    providerId: PROVIDER_ID,
    providerModel: MODEL_ID,
    key: `default:${PROVIDER_ID}:${MODEL_ID}`,
    voiceProfileIds: snapshot.entries.map((entry) => sharedProfileId(entry.voiceId)),
    traitFilter: {},
    narratorExcluded: true,
    status: 'active',
    userPinned: true,
  });
  return normalizeVoiceCastingWorkspace({
    bookId: BOOK_ID,
    contentRevisionId: CONTENT_REVISION_ID,
    storageRevision: empty.storageRevision,
    userArtifacts: { ...empty.userArtifacts, pools: [pool] },
    derivedArtifacts: empty.derivedArtifacts,
  });
}

function buildDraft(input: {
  utterances: readonly AcceptedSpeakerUtteranceV1[];
  characters: readonly Character[];
  existingProfiles?: readonly VoiceProfile[];
  existingWorkspace?: VoiceCastingWorkspaceV1;
  characterKnowledge?: ReturnType<typeof backfillCharacterGraphKnowledgeV2>;
}) {
  return buildVoiceCastingProductDraft({
    bookId: BOOK_ID,
    contentRevisionId: CONTENT_REVISION_ID,
    utterances: input.utterances,
    characters: input.characters,
    snapshot,
    existingProfiles: input.existingProfiles ?? [],
    existingWorkspace: input.existingWorkspace,
    characterKnowledge: input.characterKnowledge,
    majorCharacterLimit: 1,
    preferredLocale: 'en-US',
    createdAt: CREATED_AT,
  });
}

describe('S8 voice-casting product integration', () => {
  it('does not let a system draft replace an active hosted casting context', () => {
    const hostedDraft = buildDraft({
      utterances: [utterance({ speakerEntityId: 'speaker-alice', canonicalSpeakerId: 'alice', order: 1 })],
      characters: [character('alice', 'Alice')],
    });
    const assignment = hostedDraft.workspace.derivedArtifacts.state.assignments[0];
    expect(assignment).toBeDefined();
    const hostedProfile: VoiceProfile = {
      id: assignment!.voiceProfileId,
      novelId: BOOK_ID,
      role: 'character',
      providerId: 'elevenlabs',
      providerVoiceId: 'hosted-voice',
      label: 'Hosted voice',
      speed: 1,
      providerOptions: {},
      isUserSelected: false,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };

    expect(
      shouldPersistVoiceCastingDraft({
        scope: 'system',
        providerId: PROVIDER_ID,
        existingWorkspace: hostedDraft.workspace,
        existingProfiles: [hostedProfile],
      }),
    ).toBe(false);
    expect(
      shouldPersistVoiceCastingDraft({
        scope: 'hosted',
        providerId: 'elevenlabs',
        existingWorkspace: hostedDraft.workspace,
        existingProfiles: [hostedProfile],
      }),
    ).toBe(true);
  });

  it('marks a workspace with only a pinned user pool as user-authored', () => {
    expect(pinnedProviderPoolWorkspace().userPinned).toBe(true);
  });

  it('preserves a foreign provider pool without using it for the active provider assignment', () => {
    const base = pinnedProviderPoolWorkspace();
    const foreignProfile: VoiceProfile = {
      id: 'foreign-pool-profile',
      novelId: BOOK_ID,
      role: 'character',
      providerId: 'hosted-provider',
      providerVoiceId: 'foreign-voice',
      providerModel: 'hosted-v1',
      label: 'Foreign pool voice',
      speed: 1,
      isUserSelected: false,
    };
    const foreignPool = createVoicePoolDefinition({
      bookId: BOOK_ID,
      contentRevisionId: CONTENT_REVISION_ID,
      providerId: foreignProfile.providerId,
      providerModel: foreignProfile.providerModel,
      key: `default:${foreignProfile.providerId}:${foreignProfile.providerModel}`,
      voiceProfileIds: [foreignProfile.id],
      traitFilter: {},
      narratorExcluded: true,
      status: 'active',
      userPinned: true,
    });
    const mixed = normalizeVoiceCastingWorkspace({
      bookId: BOOK_ID,
      contentRevisionId: CONTENT_REVISION_ID,
      storageRevision: base.storageRevision,
      userArtifacts: { ...base.userArtifacts, pools: [...base.userArtifacts.pools, foreignPool] },
      derivedArtifacts: base.derivedArtifacts,
    });
    const result = buildDraft({
      utterances: [utterance({ speakerEntityId: 'speaker-alice', canonicalSpeakerId: 'alice', order: 1 })],
      characters: [character('alice', 'Alice')],
      existingProfiles: [foreignProfile],
      existingWorkspace: mixed,
    });
    const profileById = new Map(result.voiceProfiles.map((profile) => [profile.id, profile] as const));

    expect(result.workspace.userArtifacts.pools).toContainEqual(expect.objectContaining({ id: foreignPool.id }));
    expect(
      result.workspace.derivedArtifacts.state.assignments.every(
        (assignment) => profileById.get(assignment.voiceProfileId)?.providerId === PROVIDER_ID,
      ),
    ).toBe(true);
  });

  it('recomputes only voice casting when the user pins or resets a shared pool', () => {
    const draft = buildDraft({
      utterances: [
        utterance({
          speakerEntityId: 'speaker-alice',
          canonicalSpeakerId: 'alice',
          order: 1,
          sceneId: 'scene-1',
          dialogueBurstId: 'burst-1',
        }),
        utterance({
          speakerEntityId: 'speaker-bob',
          canonicalSpeakerId: 'bob',
          order: 2,
          sceneId: 'scene-1',
          dialogueBurstId: 'burst-1',
        }),
      ],
      characters: [character('alice', 'Alice'), character('bob', 'Bob')],
    });
    const sharedProfileIds = draft.voiceProfiles
      .filter((profile) => profile.id.startsWith('voice_pool_profile_'))
      .map((profile) => profile.id);
    const pinned = replaceVoiceCastingPool({
      workspace: draft.workspace,
      providerId: PROVIDER_ID,
      providerModel: MODEL_ID,
      voiceProfileIds: sharedProfileIds.slice(0, 1),
      voiceProfiles: draft.voiceProfiles,
      userPinned: true,
    });

    expect(pinned.userArtifacts.pools[0]?.voiceProfileIds).toEqual(sharedProfileIds.slice(0, 1));
    expect(pinned.derivedArtifacts.pools).toEqual([]);
    expect(pinned.userPinned).toBe(true);
    expect(pinned.derivedArtifacts.state.poolRevision).not.toBe(draft.workspace.derivedArtifacts.state.poolRevision);

    const reset = replaceVoiceCastingPool({
      workspace: pinned,
      providerId: PROVIDER_ID,
      providerModel: MODEL_ID,
      voiceProfileIds: sharedProfileIds,
      voiceProfiles: draft.voiceProfiles,
      userPinned: false,
    });
    expect(reset.userArtifacts.pools).toEqual([]);
    expect(reset.derivedArtifacts.pools[0]?.voiceProfileIds).toEqual([...sharedProfileIds].sort());
    expect(reset.userPinned).toBe(false);
  });

  it('invalidates playback assignments when a related profile write cannot be completed', () => {
    const draft = buildDraft({
      utterances: [utterance({ speakerEntityId: 'speaker-alice', canonicalSpeakerId: 'alice', order: 1 })],
      characters: [character('alice', 'Alice')],
    });
    const invalidated = invalidateVoiceCastingWorkspace(draft.workspace);

    expect(invalidated.storageRevision).toBe(draft.workspace.storageRevision + 1);
    expect(invalidated.status).toBe('stale');
    expect(invalidated.derivedArtifacts.state).toMatchObject({ status: 'stale', assignments: [] });
  });

  it('computes importance from accepted utterances across the whole book', () => {
    const utterances = [
      utterance({
        speakerEntityId: 'speaker-alice',
        canonicalSpeakerId: 'alice',
        order: 10,
        chapterId: 'chapter-1',
        sceneId: 'scene-1',
        spokenCharacterCount: 24,
      }),
      utterance({
        speakerEntityId: 'speaker-alice',
        canonicalSpeakerId: 'alice',
        order: 110,
        chapterId: 'chapter-2',
        sceneId: 'scene-2',
        spokenCharacterCount: 36,
      }),
    ];

    const result = buildDraft({
      utterances,
      characters: [character('alice', 'Alice')],
      existingWorkspace: pinnedProviderPoolWorkspace(),
    });
    const importance = result.workspace.derivedArtifacts.importanceProfiles.find(
      (profile) => profile.speakerEntityId === 'speaker-alice',
    );

    expect(importance).toMatchObject({
      mode: 'full_file',
      spokenCharacterCount: 60,
      utteranceCount: 2,
      distinctSpeakingScenes: 2,
      distinctSpeakingChapters: 2,
      firstSpeakingOrder: 10,
      lastSpeakingOrder: 110,
    });
  });

  it('uses only active graph evidence for voice traits instead of inferring from a name', () => {
    const alice = character('alice', 'Alice');
    const base = backfillCharacterGraphKnowledgeV2({ novelId: BOOK_ID, characters: [alice], relations: [] });
    const result = buildDraft({
      utterances: [utterance({ speakerEntityId: 'speaker-alice', canonicalSpeakerId: 'alice', order: 1 })],
      characters: [alice],
      characterKnowledge: {
        ...base,
        facts: [
          ...base.facts,
          {
            id: 'fact-gender-alice',
            novelId: BOOK_ID,
            characterId: 'alice',
            field: 'gender',
            value: 'female',
            confidence: 0.95,
            status: 'active',
            source: 'generated',
            lockedByUser: false,
            validity: { fromChapterIndex: 0 },
            evidenceIds: ['span-gender-alice'],
          },
        ],
      },
    });

    expect(result.workspace.derivedArtifacts.traitProfiles[0]).toMatchObject({
      genderPresentation: 'feminine',
      ageBand: 'unknown',
      provenance: ['source_rule'],
    });
    expect(result.workspace.derivedArtifacts.traitEvidence).toEqual([
      expect.objectContaining({ evidenceSpanId: 'span-gender-alice', evidenceKind: 'source_rule' }),
    ]);
  });

  it('turns provider voices into shared pool profiles and playable bindings', () => {
    const accepted = utterance({
      speakerEntityId: 'speaker-alice',
      canonicalSpeakerId: 'alice',
      order: 1,
      dialogueBurstId: 'burst-1',
    });

    const result = buildDraft({ utterances: [accepted], characters: [character('alice', 'Alice')] });
    const pool = result.workspace.derivedArtifacts.pools.find(
      (candidate) => candidate.key === `default:${PROVIDER_ID}:${MODEL_ID}`,
    );
    const sharedProfiles = result.voiceProfiles.filter((profile) =>
      snapshot.entries.some((entry) => sharedProfileId(entry.voiceId) === profile.id),
    );

    expect(sharedProfiles).toHaveLength(snapshot.entries.length);
    expect(sharedProfiles.map((profile) => profile.providerVoiceId).sort()).toEqual(
      snapshot.entries.map((entry) => entry.voiceId).sort(),
    );
    expect(pool?.voiceProfileIds).toEqual(sharedProfiles.map((profile) => profile.id).sort());
    expect(result.workspace.userArtifacts.pools).toEqual([]);
    expect(result.bindings).toEqual([
      expect.objectContaining({
        segmentId: accepted.segmentId,
        acceptedProvenanceId: accepted.acceptedProvenanceId,
        speakerEntityId: 'speaker-alice',
      }),
    ]);
    expect(pool?.voiceProfileIds).toContain(result.bindings[0]?.voiceProfileId);
  });

  it('allocates different actual voices to different speakers in one dialogue burst', () => {
    const utterances = [
      utterance({
        speakerEntityId: 'speaker-alice',
        canonicalSpeakerId: 'alice',
        order: 1,
        sceneId: 'scene-1',
        dialogueBurstId: 'burst-1',
      }),
      utterance({
        speakerEntityId: 'speaker-bob',
        canonicalSpeakerId: 'bob',
        order: 2,
        sceneId: 'scene-1',
        dialogueBurstId: 'burst-1',
      }),
    ];

    const result = buildDraft({
      utterances,
      characters: [character('alice', 'Alice'), character('bob', 'Bob')],
      existingWorkspace: pinnedProviderPoolWorkspace(),
    });
    const assignments = result.workspace.derivedArtifacts.state.assignments.filter((assignment) =>
      ['speaker-alice', 'speaker-bob'].includes(assignment.speakerEntityId),
    );

    expect(assignments).toHaveLength(2);
    expect(new Set(assignments.map((assignment) => assignment.actualVoiceKey)).size).toBe(2);
    expect(assignments.every((assignment) => assignment.method === 'min_cost_matching')).toBe(true);
  });

  it('preserves an existing user-selected character VoiceProfile unchanged', () => {
    const selected: VoiceProfile = {
      id: 'profile-alice-selected',
      novelId: BOOK_ID,
      characterId: 'alice',
      role: 'character',
      providerId: PROVIDER_ID,
      providerVoiceId: 'voice-f',
      providerModel: MODEL_ID,
      label: 'Alice selected voice',
      language: 'en-US',
      tone: 'warm',
      speed: 1.15,
      pitch: 0.95,
      emotionPolicy: 'expressive',
      providerOptions: { stability: 0.7 },
      isUserSelected: true,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    };

    const result = buildDraft({
      utterances: [utterance({ speakerEntityId: 'speaker-alice', canonicalSpeakerId: 'alice', order: 1 })],
      characters: [character('alice', 'Alice')],
      existingProfiles: [selected],
      existingWorkspace: pinnedProviderPoolWorkspace(),
    });

    expect(result.voiceProfiles.find((profile) => profile.id === selected.id)).toEqual(selected);
    expect(result.workspace.userArtifacts.voiceProfileIds).toContain(selected.id);
  });
});
