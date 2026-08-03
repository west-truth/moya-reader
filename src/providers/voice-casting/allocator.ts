import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { VoiceProfile } from '../../domain/types';
import { compareText, includesNarrativeOrder, voiceCastingIdentity } from './artifact';
import type {
  AcceptedSpeakerUtteranceV1,
  CharacterImportanceProfileV1,
  VoiceAssignmentOverrideV1,
  VoiceCastingReviewKindV1,
  VoiceCastingReviewV1,
  VoicePoolAssignmentV1,
  VoicePoolDefinitionV1,
  VoiceTierV1,
  VoiceTraitProfileV1,
} from './contracts';
import { VOICE_CASTING_VERSION } from './contracts';
import { actualProviderVoiceKey } from './pools';
import { isVoiceCastableSpeakerUtterance } from './importance';

export interface VoiceCastingAllocationInputV1 {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly utterances: readonly AcceptedSpeakerUtteranceV1[];
  readonly importanceProfiles: readonly CharacterImportanceProfileV1[];
  readonly traitProfiles: readonly VoiceTraitProfileV1[];
  readonly pools: readonly VoicePoolDefinitionV1[];
  readonly voiceProfiles: readonly VoiceProfile[];
  readonly existingAssignments?: readonly VoicePoolAssignmentV1[];
  readonly overrides?: readonly VoiceAssignmentOverrideV1[];
  readonly dedicatedVoiceProfileIdsBySpeakerEntityId?: Readonly<Record<string, readonly string[]>>;
  readonly forwardOnlyFromOrder?: number;
  readonly maxSearchNodes?: number;
}

export interface NormalizedVoiceCastingInputV1 extends VoiceCastingAllocationInputV1 {
  readonly existingAssignments: readonly VoicePoolAssignmentV1[];
  readonly overrides: readonly VoiceAssignmentOverrideV1[];
  readonly dedicatedVoiceProfileIdsBySpeakerEntityId: Readonly<Record<string, readonly string[]>>;
  readonly maxSearchNodes: number;
}

export interface VoiceCastingAllocationResultV1 {
  readonly assignments: readonly VoicePoolAssignmentV1[];
  readonly reviews: readonly VoiceCastingReviewV1[];
  readonly searchNodesVisited: number;
}

interface VoiceCandidate {
  readonly profile: VoiceProfile;
  readonly actualVoiceKey: string;
  readonly pool?: VoicePoolDefinitionV1;
}

interface ConflictGraph {
  readonly neighbors: ReadonlyMap<string, ReadonlySet<string>>;
  readonly sceneNeighbors: ReadonlyMap<string, ReadonlySet<string>>;
  readonly collisionSetBySpeaker: ReadonlyMap<string, string>;
}

const TIER_RANK: Readonly<Record<VoiceTierV1, number>> = {
  D_fallback: 0,
  C_scene_pool: 1,
  B_stable_pool: 2,
  A_dedicated: 3,
};

function sortById<T extends { readonly id: string }>(values: readonly T[]): readonly T[] {
  return [...values].sort((left, right) => compareText(left.id, right.id));
}

function belongsToInput(
  value: { readonly bookId: string; readonly contentRevisionId: string },
  input: Pick<VoiceCastingAllocationInputV1, 'bookId' | 'contentRevisionId'>,
): boolean {
  return value.bookId === input.bookId && value.contentRevisionId === input.contentRevisionId;
}

export function normalizeVoiceCastingInput(input: VoiceCastingAllocationInputV1): NormalizedVoiceCastingInputV1 {
  if (!input.bookId.trim() || !input.contentRevisionId.trim())
    throw new Error('bookId and contentRevisionId are required');
  if (
    input.forwardOnlyFromOrder !== undefined &&
    (!Number.isSafeInteger(input.forwardOnlyFromOrder) || input.forwardOnlyFromOrder < 0)
  ) {
    throw new Error('forwardOnlyFromOrder must be a nonnegative safe integer');
  }
  const maxSearchNodes = input.maxSearchNodes ?? 20_000;
  if (!Number.isSafeInteger(maxSearchNodes) || maxSearchNodes < 1) throw new Error('maxSearchNodes must be positive');

  const active = <
    T extends {
      readonly id: string;
      readonly bookId: string;
      readonly contentRevisionId: string;
      readonly status: string;
    },
  >(
    values: readonly T[],
  ) => sortById(values.filter((value) => belongsToInput(value, input) && value.status === 'active'));
  const voiceProfiles = sortById(input.voiceProfiles.filter((profile) => profile.novelId === input.bookId));
  const duplicateProfile = voiceProfiles.find((profile, index) => voiceProfiles[index - 1]?.id === profile.id);
  if (duplicateProfile) throw new Error(`Duplicate VoiceProfile id: ${duplicateProfile.id}`);

  const utterances = active(input.utterances).filter(isVoiceCastableSpeakerUtterance);
  const castableSpeakerEntityIds = new Set(utterances.map((utterance) => utterance.speakerEntityId));
  return {
    ...input,
    utterances,
    importanceProfiles: active(input.importanceProfiles).filter((profile) =>
      castableSpeakerEntityIds.has(profile.speakerEntityId),
    ),
    traitProfiles: active(input.traitProfiles).filter((profile) =>
      castableSpeakerEntityIds.has(profile.speakerEntityId),
    ),
    pools: active(input.pools),
    voiceProfiles,
    existingAssignments: active(input.existingAssignments ?? []),
    overrides: active(input.overrides ?? []),
    dedicatedVoiceProfileIdsBySpeakerEntityId: Object.fromEntries(
      Object.entries(input.dedicatedVoiceProfileIdsBySpeakerEntityId ?? {})
        .sort(([left], [right]) => compareText(left, right))
        .map(([speakerEntityId, ids]) => [speakerEntityId, [...new Set(ids)].sort(compareText)]),
    ),
    maxSearchNodes,
  };
}

function buildConflictGraph(utterances: readonly AcceptedSpeakerUtteranceV1[]): ConflictGraph {
  const burstGroups = new Map<string, Set<string>>();
  const sceneGroups = new Map<string, Set<string>>();
  const speakers = new Set<string>();
  for (const utterance of utterances) {
    speakers.add(utterance.speakerEntityId);
    const sceneGroup = sceneGroups.get(utterance.sceneId) ?? new Set<string>();
    sceneGroup.add(utterance.speakerEntityId);
    sceneGroups.set(utterance.sceneId, sceneGroup);
    if (utterance.dialogueBurstId) {
      const group = burstGroups.get(utterance.dialogueBurstId) ?? new Set<string>();
      group.add(utterance.speakerEntityId);
      burstGroups.set(utterance.dialogueBurstId, group);
    }
  }
  const neighbors = new Map([...speakers].map((speaker) => [speaker, new Set<string>()]));
  const sceneNeighbors = new Map([...speakers].map((speaker) => [speaker, new Set<string>()]));
  const addEdges = (groups: ReadonlyMap<string, ReadonlySet<string>>, target: Map<string, Set<string>>) => {
    for (const group of groups.values()) {
      const members = [...group].sort(compareText);
      for (let leftIndex = 0; leftIndex < members.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < members.length; rightIndex += 1) {
          target.get(members[leftIndex]!)!.add(members[rightIndex]!);
          target.get(members[rightIndex]!)!.add(members[leftIndex]!);
        }
      }
    }
  };
  addEdges(burstGroups, neighbors);
  addEdges(sceneGroups, sceneNeighbors);

  const collisionSetBySpeaker = new Map<string, string>();
  const visited = new Set<string>();
  for (const speaker of [...speakers].sort(compareText)) {
    if (visited.has(speaker)) continue;
    const component: string[] = [];
    const pending = [speaker];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      pending.push(...[...(neighbors.get(current) ?? [])].sort(compareText).reverse());
    }
    component.sort(compareText);
    const setId = persistentId128('voice_collision_set', component);
    for (const member of component) collisionSetBySpeaker.set(member, setId);
  }
  return { neighbors, sceneNeighbors, collisionSetBySpeaker };
}

function poolMatchesTrait(pool: VoicePoolDefinitionV1, trait: VoiceTraitProfileV1 | undefined): boolean {
  if (!trait) return Object.keys(pool.traitFilter).length === 0;
  return Object.entries(pool.traitFilter).every(
    ([key, value]) => trait[key as keyof typeof pool.traitFilter] === value,
  );
}

function candidateRank(
  input: NormalizedVoiceCastingInputV1,
  speakerEntityId: string,
  candidate: VoiceCandidate,
  existingProfileId: string | undefined,
): readonly [number, string, string] {
  const stableHash = structuredIntegrityHash([
    input.bookId,
    speakerEntityId,
    candidate.pool?.revision ?? 'dedicated',
    candidate.actualVoiceKey,
  ]);
  return [candidate.profile.id === existingProfileId ? 0 : 1, stableHash, candidate.profile.id];
}

function compareRank(left: readonly [number, string, string], right: readonly [number, string, string]): number {
  return left[0] - right[0] || compareText(left[1], right[1]) || compareText(left[2], right[2]);
}

function candidatesForSpeaker(
  input: NormalizedVoiceCastingInputV1,
  importance: CharacterImportanceProfileV1,
  trait: VoiceTraitProfileV1 | undefined,
  profiles: ReadonlyMap<string, VoiceProfile>,
  existing: VoicePoolAssignmentV1 | undefined,
): readonly VoiceCandidate[] {
  const candidateEntries: VoiceCandidate[] = [];
  if (importance.voiceTier === 'A_dedicated') {
    const explicitIds = input.dedicatedVoiceProfileIdsBySpeakerEntityId[importance.speakerEntityId] ?? [];
    const compatibleIds = input.voiceProfiles
      .filter((profile) => profile.characterId === importance.speakerEntityId)
      .map((profile) => profile.id);
    for (const profileId of [...new Set([...explicitIds, ...compatibleIds])].sort(compareText)) {
      const profile = profiles.get(profileId);
      if (profile) candidateEntries.push({ profile, actualVoiceKey: actualProviderVoiceKey(profile) });
    }
  } else {
    for (const pool of input.pools.filter((item) => poolMatchesTrait(item, trait))) {
      for (const profileId of pool.voiceProfileIds) {
        const profile = profiles.get(profileId);
        if (!profile || profile.providerId !== pool.providerId) continue;
        if (pool.providerModel !== undefined && profile.providerModel !== pool.providerModel) continue;
        if (pool.narratorExcluded && profile.role === 'narrator') continue;
        candidateEntries.push({ profile, actualVoiceKey: actualProviderVoiceKey(profile), pool });
      }
    }
  }
  const byActualVoice = new Map<string, VoiceCandidate>();
  for (const candidate of candidateEntries) {
    const current = byActualVoice.get(candidate.actualVoiceKey);
    if (!current || compareText(candidate.profile.id, current.profile.id) < 0) {
      byActualVoice.set(candidate.actualVoiceKey, candidate);
    }
  }
  return [...byActualVoice.values()].sort((left, right) =>
    compareRank(
      candidateRank(input, importance.speakerEntityId, left, existing?.voiceProfileId),
      candidateRank(input, importance.speakerEntityId, right, existing?.voiceProfileId),
    ),
  );
}

function createReview(input: {
  readonly normalized: NormalizedVoiceCastingInputV1;
  readonly kind: VoiceCastingReviewKindV1;
  readonly speakers: readonly string[];
  readonly importanceBySpeaker: ReadonlyMap<string, CharacterImportanceProfileV1>;
  readonly profileIds?: readonly string[];
  readonly assignmentIds?: readonly string[];
  readonly poolKey?: string;
  readonly userPinned?: boolean;
}): VoiceCastingReviewV1 {
  const speakers = [...new Set(input.speakers)].sort(compareText);
  const profiles = speakers
    .map((speaker) => input.importanceBySpeaker.get(speaker))
    .filter(Boolean) as CharacterImportanceProfileV1[];
  const first = [...profiles].sort(
    (left, right) =>
      left.effectiveFromOrder - right.effectiveFromOrder || compareText(left.speakerEntityId, right.speakerEntityId),
  )[0];
  const openEnded = profiles
    .filter((profile) => profile.effectiveToOrder === undefined)
    .sort((left, right) => compareText(left.speakerEntityId, right.speakerEntityId));
  const last =
    openEnded[0] ??
    [...profiles].sort(
      (left, right) =>
        (right.effectiveToOrder ?? -1) - (left.effectiveToOrder ?? -1) ||
        compareText(left.speakerEntityId, right.speakerEntityId),
    )[0];
  const core = {
    version: VOICE_CASTING_VERSION,
    bookId: input.normalized.bookId,
    contentRevisionId: input.normalized.contentRevisionId,
    kind: input.kind,
    speakerEntityIds: speakers,
    voicePoolKey: input.poolKey,
    voiceProfileIds: [...new Set(input.profileIds ?? [])].sort(compareText),
    assignmentIds: [...new Set(input.assignmentIds ?? [])].sort(compareText),
    effectiveFromOrder: first?.effectiveFromOrder ?? 0,
    effectiveToOrder: last?.effectiveToOrder,
    effectiveFromSceneId: first?.effectiveFromSceneId ?? 'unknown',
    effectiveToSceneId: last?.effectiveToSceneId,
    userPinned: input.userPinned ?? false,
  };
  return { ...core, ...voiceCastingIdentity('voice_casting_review', core), status: 'open' };
}

function assignmentCore(input: {
  readonly normalized: NormalizedVoiceCastingInputV1;
  readonly importance: CharacterImportanceProfileV1;
  readonly candidate: VoiceCandidate;
  readonly graph: ConflictGraph;
  readonly existing?: VoicePoolAssignmentV1;
  readonly override?: VoiceAssignmentOverrideV1;
}): Omit<VoicePoolAssignmentV1, 'id' | 'revision' | 'fingerprint'> {
  const { normalized, importance, candidate, existing, override } = input;
  const changedExisting = existing !== undefined && existing.voiceProfileId !== candidate.profile.id;
  const promotion = changedExisting && TIER_RANK[importance.voiceTier] > TIER_RANK[existing.voiceTier];
  const forwardStart = changedExisting
    ? Math.max(existing.effectiveFromOrder + 1, normalized.forwardOnlyFromOrder ?? importance.lastSpeakingOrder)
    : importance.effectiveFromOrder;
  const effectiveFromOrder = override?.effectiveFromOrder ?? forwardStart;
  const automaticEndOrder =
    importance.effectiveToOrder === undefined || importance.effectiveToOrder < effectiveFromOrder
      ? undefined
      : importance.effectiveToOrder;
  return {
    version: VOICE_CASTING_VERSION,
    bookId: normalized.bookId,
    contentRevisionId: normalized.contentRevisionId,
    speakerEntityId: importance.speakerEntityId,
    voiceIdentityId:
      override?.voiceIdentityId ??
      persistentId128('voice_identity', [normalized.bookId, importance.speakerEntityId, candidate.actualVoiceKey]),
    voiceTier: importance.voiceTier,
    voicePoolKey: candidate.pool?.key,
    voiceProfileId: candidate.profile.id,
    actualVoiceKey: candidate.actualVoiceKey,
    effectiveFromOrder,
    effectiveToOrder: override?.effectiveToOrder ?? automaticEndOrder,
    effectiveFromSceneId:
      override?.effectiveFromSceneId ??
      (changedExisting
        ? (importance.effectiveToSceneId ?? importance.effectiveFromSceneId)
        : importance.effectiveFromSceneId),
    effectiveToSceneId: override?.effectiveToSceneId ?? importance.effectiveToSceneId,
    method: override
      ? 'user'
      : importance.voiceTier === 'A_dedicated'
        ? 'dedicated'
        : (input.graph.neighbors.get(importance.speakerEntityId)?.size ?? 0) > 0
          ? 'min_cost_matching'
          : 'stable_hash',
    collisionSetId: input.graph.collisionSetBySpeaker.get(importance.speakerEntityId),
    promotionFromAssignmentId: promotion ? existing.id : undefined,
    retroactiveRerender: false,
    status: 'active',
    userPinned: override !== undefined,
  };
}

function materializeAssignment(
  core: Omit<VoicePoolAssignmentV1, 'id' | 'revision' | 'fingerprint'>,
): VoicePoolAssignmentV1 {
  return { ...core, ...voiceCastingIdentity('voice_pool_assignment', core) };
}

export function allocateVoicePools(rawInput: VoiceCastingAllocationInputV1): VoiceCastingAllocationResultV1 {
  const input = normalizeVoiceCastingInput(rawInput);
  const profiles = new Map(input.voiceProfiles.map((profile) => [profile.id, profile]));
  const importanceBySpeaker = new Map(input.importanceProfiles.map((profile) => [profile.speakerEntityId, profile]));
  const traitBySpeaker = new Map(input.traitProfiles.map((profile) => [profile.speakerEntityId, profile]));
  const existingBySpeaker = new Map<string, VoicePoolAssignmentV1>();
  for (const assignment of input.existingAssignments) {
    const current = existingBySpeaker.get(assignment.speakerEntityId);
    if (!current || assignment.effectiveFromOrder > current.effectiveFromOrder) {
      existingBySpeaker.set(assignment.speakerEntityId, assignment);
    }
  }
  const graph = buildConflictGraph(input.utterances);
  const reviews: VoiceCastingReviewV1[] = [];
  const pinned = new Map<string, VoiceCandidate>();
  const pinnedAssignments: VoicePoolAssignmentV1[] = [];

  const pinSources = [
    ...input.existingAssignments.filter((assignment) => assignment.userPinned),
    ...input.overrides,
  ].sort((left, right) => compareText(left.id, right.id));
  for (const pin of pinSources) {
    const profile = profiles.get(pin.voiceProfileId);
    const importance = importanceBySpeaker.get(pin.speakerEntityId);
    if (!profile || !importance) {
      reviews.push(
        createReview({
          normalized: input,
          kind: 'missing_voice_profile',
          speakers: [pin.speakerEntityId],
          importanceBySpeaker,
          profileIds: [pin.voiceProfileId],
          assignmentIds: 'id' in pin ? [pin.id] : [],
          userPinned: true,
        }),
      );
      if ('actualVoiceKey' in pin) pinnedAssignments.push(pin);
      continue;
    }
    const candidate = { profile, actualVoiceKey: actualProviderVoiceKey(profile) };
    const prior = pinned.get(pin.speakerEntityId);
    if (prior && prior.actualVoiceKey !== candidate.actualVoiceKey) {
      reviews.push(
        createReview({
          normalized: input,
          kind: 'voice_pin_conflict',
          speakers: [pin.speakerEntityId],
          importanceBySpeaker,
          profileIds: [prior.profile.id, profile.id],
          userPinned: true,
        }),
      );
    } else {
      pinned.set(pin.speakerEntityId, candidate);
    }
    if ('actualVoiceKey' in pin) {
      pinnedAssignments.push(pin);
    } else {
      pinnedAssignments.push(
        materializeAssignment(
          assignmentCore({
            normalized: input,
            importance,
            candidate,
            graph,
            override: pin,
          }),
        ),
      );
    }
  }

  for (const [speaker, candidate] of pinned) {
    for (const neighbor of graph.neighbors.get(speaker) ?? []) {
      if (compareText(speaker, neighbor) >= 0) continue;
      const neighborPin = pinned.get(neighbor);
      if (neighborPin?.actualVoiceKey === candidate.actualVoiceKey) {
        reviews.push(
          createReview({
            normalized: input,
            kind: 'voice_pin_conflict',
            speakers: [speaker, neighbor],
            importanceBySpeaker,
            profileIds: [candidate.profile.id, neighborPin.profile.id],
            userPinned: true,
          }),
        );
      }
    }
  }

  const candidates = new Map<string, readonly VoiceCandidate[]>();
  for (const importance of input.importanceProfiles) {
    const fixed = pinned.get(importance.speakerEntityId);
    const available = fixed
      ? [fixed]
      : candidatesForSpeaker(
          input,
          importance,
          traitBySpeaker.get(importance.speakerEntityId),
          profiles,
          existingBySpeaker.get(importance.speakerEntityId),
        );
    candidates.set(importance.speakerEntityId, available);
    if (available.length === 0) {
      reviews.push(
        createReview({
          normalized: input,
          kind: importance.voiceTier === 'A_dedicated' ? 'missing_dedicated_voice' : 'voice_pool_capacity',
          speakers: [importance.speakerEntityId],
          importanceBySpeaker,
        }),
      );
    }
  }

  const speakers = input.importanceProfiles
    .map((profile) => profile.speakerEntityId)
    .filter((speaker) => (candidates.get(speaker)?.length ?? 0) > 0)
    .sort(
      (left, right) =>
        (graph.neighbors.get(right)?.size ?? 0) - (graph.neighbors.get(left)?.size ?? 0) || compareText(left, right),
    );
  const components = [...new Set(speakers.map((speaker) => graph.collisionSetBySpeaker.get(speaker)!))]
    .map((setId) => speakers.filter((speaker) => graph.collisionSetBySpeaker.get(speaker) === setId))
    .sort((left, right) => compareText(left[0]!, right[0]!));
  const selected = new Map<string, VoiceCandidate>();
  const failedSpeakers = new Set<string>();
  let searchNodesVisited = 0;
  for (const component of components) {
    const componentSelection = new Map<string, VoiceCandidate>();
    let componentSearchNodes = 0;
    const search = (index: number): boolean => {
      if (index >= component.length) return true;
      if (componentSearchNodes >= input.maxSearchNodes) return false;
      const speaker = component[index]!;
      const existingProfileId = existingBySpeaker.get(speaker)?.voiceProfileId;
      const baseCandidates = candidates.get(speaker) ?? [];
      const baseRank = new Map(
        baseCandidates.map((candidate, candidateIndex) => [candidate.profile.id, candidateIndex]),
      );
      const ranked = [...baseCandidates].sort((left, right) => {
        const existingCost =
          Number(left.profile.id !== existingProfileId) - Number(right.profile.id !== existingProfileId);
        if (existingCost !== 0) return existingCost;
        const sceneCost =
          [...(graph.sceneNeighbors.get(speaker) ?? [])].filter(
            (neighbor) => selected.get(neighbor)?.actualVoiceKey === left.actualVoiceKey,
          ).length -
          [...(graph.sceneNeighbors.get(speaker) ?? [])].filter(
            (neighbor) => selected.get(neighbor)?.actualVoiceKey === right.actualVoiceKey,
          ).length;
        return sceneCost || (baseRank.get(left.profile.id) ?? 0) - (baseRank.get(right.profile.id) ?? 0);
      });
      for (const candidate of ranked) {
        componentSearchNodes += 1;
        searchNodesVisited += 1;
        const collides = [...(graph.neighbors.get(speaker) ?? [])].some(
          (neighbor) =>
            componentSelection.get(neighbor)?.actualVoiceKey === candidate.actualVoiceKey ||
            selected.get(neighbor)?.actualVoiceKey === candidate.actualVoiceKey,
        );
        if (collides) continue;
        componentSelection.set(speaker, candidate);
        if (search(index + 1)) return true;
        componentSelection.delete(speaker);
      }
      return false;
    };
    if (search(0)) {
      for (const [speaker, candidate] of componentSelection) selected.set(speaker, candidate);
    } else {
      for (const speaker of component) failedSpeakers.add(speaker);
      reviews.push(
        createReview({
          normalized: input,
          kind: 'voice_pool_capacity',
          speakers: component,
          importanceBySpeaker,
          profileIds: component.flatMap((speaker) => (candidates.get(speaker) ?? []).map((item) => item.profile.id)),
        }),
      );
    }
  }

  const assignments: VoicePoolAssignmentV1[] = [...pinnedAssignments];
  for (const importance of input.importanceProfiles) {
    if (failedSpeakers.has(importance.speakerEntityId)) continue;
    if (pinned.has(importance.speakerEntityId)) continue;
    const candidate = selected.get(importance.speakerEntityId);
    if (!candidate) continue;
    const existing = existingBySpeaker.get(importance.speakerEntityId);
    if (
      existing &&
      !existing.userPinned &&
      existing.voiceProfileId === candidate.profile.id &&
      existing.voiceTier === importance.voiceTier
    ) {
      assignments.push(existing);
      continue;
    }
    if (existing && !existing.userPinned) assignments.push(existing);
    assignments.push(
      materializeAssignment(assignmentCore({ normalized: input, importance, candidate, graph, existing })),
    );
  }

  return {
    assignments: sortById([...new Map(assignments.map((assignment) => [assignment.id, assignment])).values()]),
    reviews: sortById([...new Map(reviews.map((review) => [review.id, review])).values()]),
    searchNodesVisited,
  };
}

export function findVoiceCollisions(input: {
  readonly utterances: readonly AcceptedSpeakerUtteranceV1[];
  readonly assignments: readonly VoicePoolAssignmentV1[];
}): readonly {
  readonly leftSpeakerEntityId: string;
  readonly rightSpeakerEntityId: string;
  readonly sceneId: string;
}[] {
  const byScene = new Map<string, AcceptedSpeakerUtteranceV1[]>();
  for (const utterance of input.utterances.filter((item) => item.status === 'active')) {
    const rows = byScene.get(utterance.sceneId) ?? [];
    rows.push(utterance);
    byScene.set(utterance.sceneId, rows);
  }
  const collisions: { leftSpeakerEntityId: string; rightSpeakerEntityId: string; sceneId: string }[] = [];
  for (const [sceneId, utterances] of byScene) {
    const speakers = [...new Set(utterances.map((item) => item.speakerEntityId))].sort(compareText);
    const voiceBySpeaker = new Map<string, string>();
    for (const speaker of speakers) {
      const order = utterances.find((item) => item.speakerEntityId === speaker)!.narrativeOrder;
      const assignment = input.assignments
        .filter(
          (item) => item.status === 'active' && item.speakerEntityId === speaker && includesNarrativeOrder(item, order),
        )
        .sort(
          (left, right) =>
            right.effectiveFromOrder - left.effectiveFromOrder || Number(right.userPinned) - Number(left.userPinned),
        )[0];
      if (assignment) voiceBySpeaker.set(speaker, assignment.actualVoiceKey);
    }
    for (let leftIndex = 0; leftIndex < speakers.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < speakers.length; rightIndex += 1) {
        const left = speakers[leftIndex]!;
        const right = speakers[rightIndex]!;
        if (voiceBySpeaker.get(left) !== undefined && voiceBySpeaker.get(left) === voiceBySpeaker.get(right)) {
          collisions.push({ leftSpeakerEntityId: left, rightSpeakerEntityId: right, sceneId });
        }
      }
    }
  }
  return collisions;
}
