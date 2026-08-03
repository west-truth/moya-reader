import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { Character, VoiceProfile } from '../../domain/types';
import type { CharacterGraphKnowledgeV2 } from '../../providers/character-graph-v2';
import {
  aggregateCharacterImportance,
  computeVoiceCastingState,
  createEmptyVoiceCastingState,
  computeVoiceTraitProfiles,
  createVoiceAssignmentOverride,
  createVoicePoolDefinition,
  createVoiceTraitEvidence,
  normalizeVoiceCastingWorkspace,
  resolveTtsVoiceBindings,
  type AcceptedSpeakerUtteranceV1,
  type CharacterImportanceSignalV1,
  type TtsVoiceBindingV1,
  type VoiceAssignmentOverrideV1,
  type VoiceCastingWorkspaceV1,
  type VoicePoolDefinitionV1,
  type VoiceTraitEvidenceV1,
} from '../../providers/voice-casting';
import {
  buildAutomaticVoiceDraft,
  type VoiceCatalogSnapshotV1,
  type VoiceDraftTarget,
  type VoiceSuggestionV1,
} from '../../providers/voice-product';

const ROLE_SPEAKER_IDS = new Set(['narrator', 'system']);

export interface VoiceCastingProductDraftInput {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly utterances: readonly AcceptedSpeakerUtteranceV1[];
  readonly characters: readonly Character[];
  readonly snapshot: VoiceCatalogSnapshotV1;
  readonly existingProfiles: readonly VoiceProfile[];
  readonly existingWorkspace?: VoiceCastingWorkspaceV1;
  readonly characterKnowledge?: CharacterGraphKnowledgeV2;
  readonly majorCharacterLimit: number;
  readonly preferredLocale?: string;
  readonly createdAt?: string;
}

export interface VoiceCastingProductDraftResult {
  readonly voiceProfiles: readonly VoiceProfile[];
  readonly suggestions: readonly VoiceSuggestionV1[];
  readonly workspace: VoiceCastingWorkspaceV1;
  readonly bindings: readonly TtsVoiceBindingV1[];
  readonly unresolvedSegmentIds: readonly string[];
}

export interface ReplaceVoiceCastingPoolInput {
  readonly workspace: VoiceCastingWorkspaceV1;
  readonly providerId: string;
  readonly providerModel?: string;
  readonly voiceProfileIds: readonly string[];
  readonly voiceProfiles: readonly VoiceProfile[];
  readonly userPinned: boolean;
}

function profileMatchesProvider(
  profile: VoiceProfile | undefined,
  providerId: string,
  providerModel?: string,
): boolean {
  return Boolean(
    profile &&
    profile.providerId === providerId &&
    (providerModel === undefined || profile.providerModel === providerModel),
  );
}

function poolMatchesProvider(pool: VoicePoolDefinitionV1, providerId: string, providerModel?: string): boolean {
  return pool.providerId === providerId && pool.providerModel === providerModel;
}

export function shouldPersistVoiceCastingDraft(input: {
  readonly scope: 'system' | 'hosted';
  readonly providerId: string;
  readonly existingWorkspace?: VoiceCastingWorkspaceV1;
  readonly existingProfiles: readonly VoiceProfile[];
}): boolean {
  if (!input.existingWorkspace || input.scope === 'hosted') return true;

  const profileById = new Map(input.existingProfiles.map((profile) => [profile.id, profile] as const));
  const activeProviderIds = new Set(
    input.existingWorkspace.derivedArtifacts.state.assignments
      .filter((assignment) => assignment.status === 'active')
      .map((assignment) => profileById.get(assignment.voiceProfileId)?.providerId)
      .filter((providerId): providerId is string => providerId !== undefined),
  );
  if (activeProviderIds.size === 0) {
    for (const pool of input.existingWorkspace.derivedArtifacts.pools) {
      if (pool.status === 'active') activeProviderIds.add(pool.providerId);
    }
  }
  return activeProviderIds.size === 0 || [...activeProviderIds].every((providerId) => providerId === input.providerId);
}

export function replaceVoiceCastingPool(input: ReplaceVoiceCastingPoolInput): VoiceCastingWorkspaceV1 {
  if (input.voiceProfileIds.length === 0) throw new Error('공유 음성 풀에는 음성이 하나 이상 필요합니다.');
  const key = `default:${input.providerId}:${input.providerModel ?? 'default'}`;
  const pool = createVoicePoolDefinition({
    bookId: input.workspace.bookId,
    contentRevisionId: input.workspace.contentRevisionId,
    providerId: input.providerId,
    providerModel: input.providerModel,
    key,
    voiceProfileIds: input.voiceProfileIds,
    traitFilter: {},
    narratorExcluded: true,
    status: 'active',
    userPinned: input.userPinned,
  });
  const userPools = input.workspace.userArtifacts.pools.filter((candidate) => candidate.key !== key);
  const derivedPools = input.workspace.derivedArtifacts.pools.filter((candidate) => candidate.key !== key);
  if (input.userPinned) userPools.push(pool);
  else derivedPools.push(pool);

  const derived = input.workspace.derivedArtifacts;
  const profileById = new Map(input.voiceProfiles.map((profile) => [profile.id, profile] as const));
  const allocationPools = [...userPools, ...derivedPools].filter((candidate) =>
    poolMatchesProvider(candidate, input.providerId, input.providerModel),
  );
  const applicableOverrides = input.workspace.userArtifacts.overrides.filter((override) =>
    profileMatchesProvider(profileById.get(override.voiceProfileId), input.providerId),
  );
  const activeAssignments = derived.state.assignments.filter((assignment) =>
    profileMatchesProvider(profileById.get(assignment.voiceProfileId), input.providerId),
  );
  const dedicatedVoiceProfileIdsBySpeakerEntityId = Object.fromEntries(
    activeAssignments
      .filter((assignment) => assignment.status === 'active' && assignment.voiceTier === 'A_dedicated')
      .map((assignment) => [assignment.speakerEntityId, [assignment.voiceProfileId]] as const),
  );
  const state = computeVoiceCastingState({
    bookId: input.workspace.bookId,
    contentRevisionId: input.workspace.contentRevisionId,
    utterances: derived.utterances,
    importanceProfiles: derived.importanceProfiles,
    traitProfiles: derived.traitProfiles,
    pools: allocationPools,
    voiceProfiles: input.voiceProfiles,
    existingAssignments: activeAssignments,
    overrides: applicableOverrides,
    dedicatedVoiceProfileIdsBySpeakerEntityId,
  });
  return normalizeVoiceCastingWorkspace({
    bookId: input.workspace.bookId,
    contentRevisionId: input.workspace.contentRevisionId,
    storageRevision: input.workspace.storageRevision + 1,
    userArtifacts: { ...input.workspace.userArtifacts, pools: userPools },
    derivedArtifacts: {
      ...derived,
      pools: derivedPools.filter((candidate) => poolMatchesProvider(candidate, input.providerId, input.providerModel)),
      state,
    },
  });
}

export function invalidateVoiceCastingWorkspace(workspace: VoiceCastingWorkspaceV1): VoiceCastingWorkspaceV1 {
  return normalizeVoiceCastingWorkspace({
    bookId: workspace.bookId,
    contentRevisionId: workspace.contentRevisionId,
    storageRevision: workspace.storageRevision + 1,
    status: 'stale',
    userArtifacts: workspace.userArtifacts,
    derivedArtifacts: {
      ...workspace.derivedArtifacts,
      state: createEmptyVoiceCastingState({
        bookId: workspace.bookId,
        contentRevisionId: workspace.contentRevisionId,
        status: 'stale',
      }),
    },
  });
}

function activeCharacterUtterances(
  utterances: readonly AcceptedSpeakerUtteranceV1[],
): readonly AcceptedSpeakerUtteranceV1[] {
  return utterances.filter(
    (utterance) => utterance.status === 'active' && !ROLE_SPEAKER_IDS.has(utterance.speakerEntityId),
  );
}

function canonicalSpeakerByEntity(utterances: readonly AcceptedSpeakerUtteranceV1[]): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const utterance of [...utterances].sort((left, right) => left.narrativeOrder - right.narrativeOrder)) {
    if (!['unknown', 'narrator', 'system'].includes(utterance.canonicalSpeakerId)) {
      result.set(utterance.speakerEntityId, utterance.canonicalSpeakerId);
    }
  }
  return result;
}

function importanceSignals(input: {
  readonly utterances: readonly AcceptedSpeakerUtteranceV1[];
  readonly characters: readonly Character[];
  readonly workspace?: VoiceCastingWorkspaceV1;
}): readonly CharacterImportanceSignalV1[] {
  const characterIds = new Set(input.characters.map((character) => character.id));
  const canonicalByEntity = canonicalSpeakerByEntity(input.utterances);
  const pinned = new Set(
    input.workspace?.userArtifacts.overrides
      .filter((override) => override.status === 'active')
      .map((item) => item.speakerEntityId),
  );
  return [...new Set(input.utterances.map((utterance) => utterance.speakerEntityId))].map((speakerEntityId) => ({
    speakerEntityId,
    namedIdentity: characterIds.has(canonicalByEntity.get(speakerEntityId) ?? ''),
    majorRelation: false,
    userPinned: pinned.has(speakerEntityId),
  }));
}

function voiceTargets(input: {
  readonly characters: readonly Character[];
  readonly importance: ReturnType<typeof aggregateCharacterImportance>;
  readonly utterances: readonly AcceptedSpeakerUtteranceV1[];
  readonly majorCharacterLimit: number;
}): readonly VoiceDraftTarget[] {
  const canonicalByEntity = canonicalSpeakerByEntity(input.utterances);
  const importanceByCharacter = new Map<string, (typeof input.importance)[number]>();
  for (const profile of input.importance) {
    const characterId = canonicalByEntity.get(profile.speakerEntityId);
    if (!characterId) continue;
    const current = importanceByCharacter.get(characterId);
    if (!current || profile.importanceScore > current.importanceScore) importanceByCharacter.set(characterId, profile);
  }
  const rankedMajorIds = new Set(
    [...input.characters]
      .sort(
        (left, right) =>
          (importanceByCharacter.get(right.id)?.importanceScore ?? 0) -
            (importanceByCharacter.get(left.id)?.importanceScore ?? 0) || left.id.localeCompare(right.id),
      )
      .slice(0, Math.max(1, Math.floor(input.majorCharacterLimit)))
      .map((character) => character.id),
  );
  return [
    { key: 'role:narrator', role: 'narrator', label: '내레이터', major: true, spokenCharacters: 0 },
    { key: 'role:system', role: 'system', label: '시스템 문구', major: true, spokenCharacters: 0 },
    { key: 'role:unknown', role: 'unknown', label: '화자 미정', major: true, spokenCharacters: 0 },
    ...input.characters.map((character) => {
      const profile = importanceByCharacter.get(character.id);
      return {
        key: `character:${character.id}`,
        role: 'character' as const,
        characterId: character.id,
        label: character.canonicalName,
        major: profile?.voiceTier === 'A_dedicated' || rankedMajorIds.has(character.id),
        spokenCharacters: profile?.spokenCharacterCount ?? 0,
      };
    }),
  ];
}

function sharedPoolProfiles(input: {
  readonly bookId: string;
  readonly snapshot: VoiceCatalogSnapshotV1;
  readonly existingProfiles: readonly VoiceProfile[];
  readonly createdAt: string;
  readonly preferredLocale?: string;
}): readonly VoiceProfile[] {
  const preferredLanguage = input.preferredLocale?.split('-')[0]?.toLowerCase();
  const available = input.snapshot.entries.filter((entry) => entry.available);
  const localized = preferredLanguage
    ? available.filter((entry) => entry.locale?.split('-')[0]?.toLowerCase() === preferredLanguage)
    : [];
  const entries = localized.length > 0 ? localized : available;
  return entries.map((entry) => {
    const id = persistentId128('voice_pool_profile', [
      input.bookId,
      input.snapshot.providerId,
      input.snapshot.modelId ?? '',
      entry.voiceId,
    ]);
    const existing = input.existingProfiles.find((profile) => profile.id === id);
    return {
      ...(existing ?? {}),
      id,
      novelId: input.bookId,
      characterId: undefined,
      role: 'character' as const,
      providerId: input.snapshot.providerId,
      providerVoiceId: entry.voiceId,
      providerModel: input.snapshot.modelId,
      label: `공유 음성 · ${entry.label}`,
      language: entry.locale,
      speed: existing?.speed ?? 1,
      providerOptions: existing?.providerOptions ?? {},
      isUserSelected: existing?.isUserSelected ?? false,
      createdAt: existing?.createdAt ?? input.createdAt,
      updatedAt: input.createdAt,
    };
  });
}

function rebasePools(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly existingWorkspace?: VoiceCastingWorkspaceV1;
}): readonly VoicePoolDefinitionV1[] {
  return (input.existingWorkspace?.userArtifacts.pools ?? []).map((pool) =>
    createVoicePoolDefinition({
      bookId: input.bookId,
      contentRevisionId: input.contentRevisionId,
      providerId: pool.providerId,
      providerModel: pool.providerModel,
      key: pool.key,
      voiceProfileIds: pool.voiceProfileIds,
      traitFilter: pool.traitFilter,
      narratorExcluded: pool.narratorExcluded,
      status: pool.status,
      userPinned: pool.userPinned,
    }),
  );
}

function rebaseUserTraitEvidence(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly existingWorkspace?: VoiceCastingWorkspaceV1;
  readonly importance: ReturnType<typeof aggregateCharacterImportance>;
}): readonly VoiceTraitEvidenceV1[] {
  const importanceBySpeaker = new Map(input.importance.map((profile) => [profile.speakerEntityId, profile] as const));
  return (input.existingWorkspace?.userArtifacts.traitEvidence ?? []).flatMap((evidence) => {
    if (evidence.contentRevisionId === input.contentRevisionId) return [evidence];
    const profile = importanceBySpeaker.get(evidence.speakerEntityId);
    if (!profile) return [];
    return [
      createVoiceTraitEvidence({
        bookId: input.bookId,
        contentRevisionId: input.contentRevisionId,
        speakerEntityId: evidence.speakerEntityId,
        sceneId: profile.effectiveFromSceneId,
        narrativeOrder: profile.effectiveFromOrder,
        evidenceSpanId: `user:${evidence.speakerEntityId}`,
        evidenceKind: 'user',
        proposedTraits: evidence.proposedTraits,
        confidence: evidence.confidence,
        status: evidence.status,
        userPinned: evidence.userPinned,
      }),
    ];
  });
}

function normalizedTraitToken(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[\s-]+/g, '_');
}

function mappedTraitValue(
  trait: 'gender_presentation' | 'age_band' | 'vocal_weight' | 'register_default',
  value: string,
): Partial<VoiceTraitEvidenceV1['proposedTraits']> {
  const token = normalizedTraitToken(value);
  if (trait === 'gender_presentation') {
    if (['male', 'man', 'masculine', '남성', '남자'].includes(token)) return { genderPresentation: 'masculine' };
    if (['female', 'woman', 'feminine', '여성', '여자'].includes(token)) return { genderPresentation: 'feminine' };
    if (['androgynous', 'neutral', '중성'].includes(token)) return { genderPresentation: 'androgynous' };
  }
  if (trait === 'age_band') {
    if (['child', '어린이', '아동'].includes(token)) return { ageBand: 'child' };
    if (['adolescent', 'teen', '청소년'].includes(token)) return { ageBand: 'adolescent' };
    if (['young_adult', '청년'].includes(token)) return { ageBand: 'young_adult' };
    if (['adult', '성인'].includes(token)) return { ageBand: 'adult' };
    if (['older_adult', '중년'].includes(token)) return { ageBand: 'older_adult' };
    if (['elderly', '노년', '노인'].includes(token)) return { ageBand: 'elderly' };
  }
  if (trait === 'vocal_weight') {
    if (['light', '가벼움', '가벼운'].includes(token)) return { vocalWeight: 'light' };
    if (['medium', '보통'].includes(token)) return { vocalWeight: 'medium' };
    if (['heavy', '무거움', '무거운'].includes(token)) return { vocalWeight: 'heavy' };
  }
  if (trait === 'register_default') {
    if (['casual', 'informal', '반말'].includes(token)) return { registerDefault: 'casual' };
    if (['polite', '존댓말', '존대'].includes(token)) return { registerDefault: 'polite' };
    if (['formal', '격식', '격식체'].includes(token)) return { registerDefault: 'formal' };
    if (['rough', '거침', '거친'].includes(token)) return { registerDefault: 'rough' };
    if (['neutral', '중립'].includes(token)) return { registerDefault: 'neutral' };
  }
  return {};
}

function sourceTraitEvidence(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly utterances: readonly AcceptedSpeakerUtteranceV1[];
  readonly importance: ReturnType<typeof aggregateCharacterImportance>;
  readonly knowledge?: CharacterGraphKnowledgeV2;
}): readonly VoiceTraitEvidenceV1[] {
  if (!input.knowledge) return [];
  const importanceBySpeaker = new Map(input.importance.map((profile) => [profile.speakerEntityId, profile] as const));
  const canonicalByEntity = canonicalSpeakerByEntity(input.utterances);
  const rows: VoiceTraitEvidenceV1[] = [];
  const append = (entry: {
    readonly speakerEntityId: string;
    readonly evidenceSpanId: string;
    readonly proposedTraits: Partial<VoiceTraitEvidenceV1['proposedTraits']>;
    readonly confidence: number;
    readonly userPinned: boolean;
  }) => {
    if (Object.keys(entry.proposedTraits).length === 0) return;
    const importance = importanceBySpeaker.get(entry.speakerEntityId);
    if (!importance) return;
    rows.push(
      createVoiceTraitEvidence({
        bookId: input.bookId,
        contentRevisionId: input.contentRevisionId,
        speakerEntityId: entry.speakerEntityId,
        sceneId: importance.effectiveFromSceneId,
        narrativeOrder: importance.effectiveFromOrder,
        evidenceSpanId: entry.evidenceSpanId,
        evidenceKind: entry.userPinned ? 'user' : 'source_rule',
        proposedTraits: entry.proposedTraits,
        confidence: entry.confidence,
        status: 'active',
        userPinned: entry.userPinned,
      }),
    );
  };
  for (const [speakerEntityId, characterId] of canonicalByEntity) {
    for (const fact of input.knowledge.facts.filter(
      (candidate) =>
        candidate.characterId === characterId && candidate.status === 'active' && candidate.field === 'gender',
    )) {
      append({
        speakerEntityId,
        evidenceSpanId: fact.evidenceIds[0] ?? fact.id,
        proposedTraits: mappedTraitValue('gender_presentation', fact.value),
        confidence: fact.confidence,
        userPinned: fact.source === 'user' && fact.lockedByUser,
      });
    }
    for (const trait of input.knowledge.speechTraits.filter(
      (candidate) => candidate.characterId === characterId && candidate.status === 'active',
    )) {
      const traitKey = normalizedTraitToken(trait.trait);
      const mapped =
        traitKey === 'gender' || traitKey === 'gender_presentation'
          ? mappedTraitValue('gender_presentation', trait.value)
          : traitKey === 'age' || traitKey === 'age_band'
            ? mappedTraitValue('age_band', trait.value)
            : traitKey === 'vocal_weight'
              ? mappedTraitValue('vocal_weight', trait.value)
              : traitKey === 'speech_style' || traitKey === 'register' || traitKey === 'register_default'
                ? mappedTraitValue('register_default', trait.value)
                : {};
      append({
        speakerEntityId,
        evidenceSpanId: trait.evidenceIds[0] ?? trait.id,
        proposedTraits: mapped,
        confidence: trait.confidence,
        userPinned: false,
      });
    }
  }
  return [...new Map(rows.map((row) => [row.id, row] as const)).values()];
}

function applicableOverrides(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly workspace?: VoiceCastingWorkspaceV1;
  readonly importance: ReturnType<typeof aggregateCharacterImportance>;
}): readonly VoiceAssignmentOverrideV1[] {
  const importanceBySpeaker = new Map(input.importance.map((profile) => [profile.speakerEntityId, profile] as const));
  return (input.workspace?.userArtifacts.overrides ?? []).flatMap((override) => {
    if (override.contentRevisionId === input.contentRevisionId) return [override];
    const profile = importanceBySpeaker.get(override.speakerEntityId);
    if (!profile) return [];
    return [
      createVoiceAssignmentOverride({
        bookId: input.bookId,
        contentRevisionId: input.contentRevisionId,
        speakerEntityId: override.speakerEntityId,
        voiceIdentityId: override.voiceIdentityId,
        voiceProfileId: override.voiceProfileId,
        reasonCode: override.reasonCode,
        effectiveFromOrder: profile.effectiveFromOrder,
        effectiveToOrder: profile.effectiveToOrder,
        effectiveFromSceneId: profile.effectiveFromSceneId,
        effectiveToSceneId: profile.effectiveToSceneId,
        status: override.status,
      }),
    ];
  });
}

export function buildVoiceCastingProductDraft(input: VoiceCastingProductDraftInput): VoiceCastingProductDraftResult {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const utterances = activeCharacterUtterances(input.utterances);
  const importance = aggregateCharacterImportance({
    utterances,
    mode: 'full_file',
    signals: importanceSignals({ utterances, characters: input.characters, workspace: input.existingWorkspace }),
  });
  const targets = voiceTargets({
    characters: input.characters,
    importance,
    utterances,
    majorCharacterLimit: input.majorCharacterLimit,
  });
  const baseDraft = buildAutomaticVoiceDraft({
    novelId: input.bookId,
    snapshot: input.snapshot,
    targets,
    existingProfiles: input.existingProfiles,
    preferredLocale: input.preferredLocale,
    createdAt,
  });
  const sharedProfiles = sharedPoolProfiles({
    bookId: input.bookId,
    snapshot: input.snapshot,
    existingProfiles: baseDraft.profiles,
    preferredLocale: input.preferredLocale,
    createdAt,
  });
  const voiceProfiles = [
    ...new Map([...baseDraft.profiles, ...sharedProfiles].map((profile) => [profile.id, profile])).values(),
  ];
  const rebasedPools = rebasePools(input);
  const providerPoolKey = `default:${input.snapshot.providerId}:${input.snapshot.modelId ?? 'default'}`;
  const providerPools = rebasedPools.filter((pool) =>
    poolMatchesProvider(pool, input.snapshot.providerId, input.snapshot.modelId),
  );
  const existingProviderPool = providerPools.find(
    (pool) => pool.key === providerPoolKey && pool.providerId === input.snapshot.providerId,
  );
  const generatedPool = createVoicePoolDefinition({
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    providerId: input.snapshot.providerId,
    providerModel: input.snapshot.modelId,
    key: providerPoolKey,
    voiceProfileIds: sharedProfiles.map((profile) => profile.id),
    traitFilter: {},
    narratorExcluded: true,
    status: 'active',
    userPinned: false,
  });
  const pools = [
    ...providerPools.filter((pool) => pool.id !== existingProviderPool?.id),
    existingProviderPool?.userPinned ? existingProviderPool : generatedPool,
  ];
  const graphEvidence = sourceTraitEvidence({
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    utterances,
    importance,
    knowledge: input.characterKnowledge,
  });
  const userTraitEvidence = [
    ...new Map(
      [
        ...rebaseUserTraitEvidence({ ...input, importance }),
        ...graphEvidence.filter((evidence) => evidence.userPinned),
      ].map((evidence) => [evidence.id, evidence] as const),
    ).values(),
  ];
  const carriedMicroPassEvidence =
    input.existingWorkspace?.contentRevisionId === input.contentRevisionId
      ? input.existingWorkspace.derivedArtifacts.traitEvidence.filter(
          (evidence) => evidence.evidenceKind === 'llm_micro_pass',
        )
      : [];
  const derivedTraitEvidence = [
    ...new Map(
      [...carriedMicroPassEvidence, ...graphEvidence.filter((evidence) => !evidence.userPinned)].map(
        (evidence) => [evidence.id, evidence] as const,
      ),
    ).values(),
  ];
  const traitProfiles = computeVoiceTraitProfiles({
    importanceProfiles: importance,
    evidence: [...userTraitEvidence, ...derivedTraitEvidence],
  });
  const rebasedOverrides = applicableOverrides({
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    workspace: input.existingWorkspace,
    importance,
  });
  const profileById = new Map(voiceProfiles.map((profile) => [profile.id, profile] as const));
  const overrides = rebasedOverrides.filter((override) =>
    profileMatchesProvider(profileById.get(override.voiceProfileId), input.snapshot.providerId),
  );
  const canonicalByEntity = canonicalSpeakerByEntity(utterances);
  const dedicatedVoiceProfileIdsBySpeakerEntityId = Object.fromEntries(
    importance
      .filter((profile) => profile.voiceTier === 'A_dedicated')
      .map((profile) => {
        const canonicalId = canonicalByEntity.get(profile.speakerEntityId);
        const profileId = voiceProfiles.find(
          (voice) =>
            voice.providerId === input.snapshot.providerId &&
            voice.role === 'character' &&
            voice.characterId === (canonicalId ?? profile.speakerEntityId),
        )?.id;
        return [profile.speakerEntityId, profileId ? [profileId] : []] as const;
      }),
  );
  const castingState = computeVoiceCastingState({
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    utterances,
    importanceProfiles: importance,
    traitProfiles,
    pools,
    voiceProfiles,
    existingAssignments:
      input.existingWorkspace?.contentRevisionId === input.contentRevisionId
        ? input.existingWorkspace.derivedArtifacts.state.assignments.filter((assignment) =>
            profileMatchesProvider(profileById.get(assignment.voiceProfileId), input.snapshot.providerId),
          )
        : [],
    overrides,
    dedicatedVoiceProfileIdsBySpeakerEntityId,
  });
  const storageRevision = (input.existingWorkspace?.storageRevision ?? 0) + 1;
  const workspace = normalizeVoiceCastingWorkspace({
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    storageRevision,
    userArtifacts: {
      voiceProfileIds: voiceProfiles.filter((profile) => profile.isUserSelected).map((profile) => profile.id),
      pools: rebasedPools.filter((pool) => pool.userPinned),
      overrides: rebasedOverrides,
      traitEvidence: userTraitEvidence,
    },
    derivedArtifacts: {
      utterances,
      importanceProfiles: importance,
      traitEvidence: derivedTraitEvidence,
      traitProfiles,
      pools: pools.filter((pool) => !pool.userPinned),
      state: castingState,
    },
  });
  const projection = resolveTtsVoiceBindings({
    utterances,
    assignments: castingState.assignments,
    voiceProfiles,
    providerId: input.snapshot.providerId,
  });
  return {
    voiceProfiles,
    suggestions: baseDraft.suggestions,
    workspace,
    bindings: projection.bindings,
    unresolvedSegmentIds: projection.unresolvedSegmentIds,
  };
}

export function voiceCastingProductFingerprint(input: VoiceCastingProductDraftResult): string {
  return structuredIntegrityHash({
    workspace: input.workspace.fingerprint,
    profiles: input.voiceProfiles.map((profile) => profile.id).sort(),
    bindings: input.bindings.map((binding) => [binding.segmentId, binding.voiceAssignmentRevision]).sort(),
  });
}
