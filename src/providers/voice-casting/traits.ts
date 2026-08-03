import { compareText, voiceCastingIdentity } from './artifact';
import type {
  CharacterImportanceProfileV1,
  VoiceTraitEvidenceV1,
  VoiceTraitMicroPassCandidateV1,
  VoiceTraitProfileV1,
  VoiceTraitValuesV1,
} from './contracts';
import { VOICE_CASTING_VERSION } from './contracts';

const TRAIT_KEYS: readonly (keyof VoiceTraitValuesV1)[] = [
  'genderPresentation',
  'ageBand',
  'vocalWeight',
  'registerDefault',
];

export interface VoiceTraitResolutionPolicyV1 {
  readonly minimumConfidence: number;
  readonly ambiguityMargin: number;
  readonly maxMicroPassCandidates: number;
  readonly minMicroPassEvidence: number;
  readonly maxMicroPassEvidence: number;
}

export const DEFAULT_VOICE_TRAIT_POLICY_V1: VoiceTraitResolutionPolicyV1 = {
  minimumConfidence: 0.65,
  ambiguityMargin: 0.1,
  maxMicroPassCandidates: 12,
  minMicroPassEvidence: 2,
  maxMicroPassEvidence: 6,
};

export function createVoiceTraitEvidence(
  input: Omit<VoiceTraitEvidenceV1, 'version' | 'id' | 'revision' | 'fingerprint'>,
): VoiceTraitEvidenceV1 {
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error('Voice trait evidence confidence must be between 0 and 1');
  }
  if (!Number.isSafeInteger(input.narrativeOrder) || input.narrativeOrder < 0) {
    throw new Error('Voice trait evidence narrativeOrder must be a nonnegative safe integer');
  }
  if (input.evidenceKind === 'name_only' && input.userPinned) {
    throw new Error('Name-only evidence cannot be user pinned');
  }
  const core = { version: VOICE_CASTING_VERSION, ...input };
  return { ...core, ...voiceCastingIdentity('voice_trait_evidence', core) };
}

function validatePolicy(policy: VoiceTraitResolutionPolicyV1): void {
  if (policy.minimumConfidence < 0 || policy.minimumConfidence > 1) {
    throw new Error('minimumConfidence must be between 0 and 1');
  }
  if (policy.ambiguityMargin < 0 || policy.ambiguityMargin > 1) {
    throw new Error('ambiguityMargin must be between 0 and 1');
  }
  if (
    !Number.isSafeInteger(policy.minMicroPassEvidence) ||
    !Number.isSafeInteger(policy.maxMicroPassEvidence) ||
    policy.minMicroPassEvidence < 1 ||
    policy.maxMicroPassEvidence < policy.minMicroPassEvidence
  ) {
    throw new Error('Micro-pass evidence bounds are invalid');
  }
}

function resolveTrait(
  key: keyof VoiceTraitValuesV1,
  evidence: readonly VoiceTraitEvidenceV1[],
  policy: VoiceTraitResolutionPolicyV1,
): { readonly value: string; readonly confidence: number; readonly evidence: readonly VoiceTraitEvidenceV1[] } {
  const usable = evidence.filter(
    (item) => item.status === 'active' && item.evidenceKind !== 'name_only' && item.proposedTraits[key] !== undefined,
  );
  const user = usable
    .filter((item) => item.evidenceKind === 'user')
    .sort((left, right) => right.confidence - left.confidence || compareText(left.id, right.id));
  if (user.length > 0) {
    const selected = user[0]!;
    return { value: selected.proposedTraits[key]!, confidence: selected.confidence, evidence: [selected] };
  }

  const scores = new Map<string, { score: number; evidence: VoiceTraitEvidenceV1[] }>();
  for (const item of usable) {
    const value = item.proposedTraits[key]!;
    const entry = scores.get(value) ?? { score: 0, evidence: [] };
    entry.score += item.confidence;
    entry.evidence.push(item);
    scores.set(value, entry);
  }
  const ranked = [...scores.entries()].sort(
    ([leftValue, left], [rightValue, right]) => right.score - left.score || compareText(leftValue, rightValue),
  );
  const first = ranked[0];
  if (!first) return { value: 'unknown', confidence: 0, evidence: [] };
  const total = ranked.reduce((sum, [, entry]) => sum + entry.score, 0);
  const confidence = total === 0 ? 0 : first[1].score / total;
  const runnerUp = ranked[1]?.[1].score ?? 0;
  const margin = total === 0 ? 0 : (first[1].score - runnerUp) / total;
  if (confidence < policy.minimumConfidence || margin < policy.ambiguityMargin) {
    return { value: 'unknown', confidence, evidence: usable };
  }
  return {
    value: first[0],
    confidence,
    evidence: first[1].evidence.sort((left, right) => compareText(left.id, right.id)),
  };
}

export function computeVoiceTraitProfiles(input: {
  readonly importanceProfiles: readonly CharacterImportanceProfileV1[];
  readonly evidence: readonly VoiceTraitEvidenceV1[];
  readonly policy?: VoiceTraitResolutionPolicyV1;
}): readonly VoiceTraitProfileV1[] {
  const policy = input.policy ?? DEFAULT_VOICE_TRAIT_POLICY_V1;
  validatePolicy(policy);
  return input.importanceProfiles
    .filter((profile) => profile.status === 'active')
    .sort((left, right) => compareText(left.speakerEntityId, right.speakerEntityId))
    .map((importance) => {
      const evidence = input.evidence.filter(
        (item) =>
          item.bookId === importance.bookId &&
          item.contentRevisionId === importance.contentRevisionId &&
          item.speakerEntityId === importance.speakerEntityId,
      );
      const resolved = Object.fromEntries(
        TRAIT_KEYS.map((key) => [key, resolveTrait(key, evidence, policy)]),
      ) as Record<keyof VoiceTraitValuesV1, ReturnType<typeof resolveTrait>>;
      const contributing = [
        ...new Map(TRAIT_KEYS.flatMap((key) => resolved[key].evidence).map((item) => [item.id, item])).values(),
      ].sort((left, right) => compareText(left.id, right.id));
      const provenance = [
        ...new Set(contributing.map((item) => item.evidenceKind).filter((kind) => kind !== 'name_only')),
      ].sort() as VoiceTraitProfileV1['provenance'];
      const resolvedConfidence = TRAIT_KEYS.map((key) => resolved[key])
        .filter((item) => item.value !== 'unknown')
        .map((item) => item.confidence);
      const core = {
        version: VOICE_CASTING_VERSION,
        bookId: importance.bookId,
        contentRevisionId: importance.contentRevisionId,
        speakerEntityId: importance.speakerEntityId,
        effectiveFromOrder: importance.effectiveFromOrder,
        effectiveToOrder: importance.effectiveToOrder,
        effectiveFromSceneId: importance.effectiveFromSceneId,
        effectiveToSceneId: importance.effectiveToSceneId,
        genderPresentation: resolved.genderPresentation.value as VoiceTraitProfileV1['genderPresentation'],
        ageBand: resolved.ageBand.value as VoiceTraitProfileV1['ageBand'],
        vocalWeight: resolved.vocalWeight.value as VoiceTraitProfileV1['vocalWeight'],
        registerDefault: resolved.registerDefault.value as VoiceTraitProfileV1['registerDefault'],
        confidence: resolvedConfidence.length === 0 ? 0 : Math.min(...resolvedConfidence),
        evidenceSpanIds: [...new Set(contributing.map((item) => item.evidenceSpanId))].sort(compareText),
        provenance,
        userPinned: contributing.some((item) => item.evidenceKind === 'user' && item.userPinned),
      };
      return { ...core, ...voiceCastingIdentity('voice_trait_profile', core), status: 'active' as const };
    });
}

export function projectVoiceTraitMicroPassCandidates(input: {
  readonly profiles: readonly VoiceTraitProfileV1[];
  readonly evidence: readonly VoiceTraitEvidenceV1[];
  readonly attemptedProfileRevisions?: ReadonlySet<string>;
  readonly policy?: VoiceTraitResolutionPolicyV1;
}): readonly VoiceTraitMicroPassCandidateV1[] {
  const policy = input.policy ?? DEFAULT_VOICE_TRAIT_POLICY_V1;
  validatePolicy(policy);
  const attempted = input.attemptedProfileRevisions ?? new Set<string>();
  return input.profiles
    .filter((profile) => profile.status === 'active' && !attempted.has(profile.revision))
    .sort((left, right) => compareText(left.speakerEntityId, right.speakerEntityId))
    .flatMap((profile) => {
      const unresolvedTraits = TRAIT_KEYS.filter((key) => profile[key] === 'unknown');
      if (unresolvedTraits.length === 0 || profile.userPinned) return [];
      const evidence = input.evidence
        .filter(
          (item) =>
            item.status === 'active' &&
            item.bookId === profile.bookId &&
            item.contentRevisionId === profile.contentRevisionId &&
            item.speakerEntityId === profile.speakerEntityId &&
            item.evidenceKind === 'source_rule' &&
            unresolvedTraits.some((key) => item.proposedTraits[key] !== undefined),
        )
        .sort((left, right) => right.confidence - left.confidence || compareText(left.id, right.id));
      if (evidence.length < policy.minMicroPassEvidence) return [];
      return [
        {
          bookId: profile.bookId,
          contentRevisionId: profile.contentRevisionId,
          speakerEntityId: profile.speakerEntityId,
          profileRevision: profile.revision,
          unresolvedTraits,
          evidenceSpanIds: evidence.slice(0, policy.maxMicroPassEvidence).map((item) => item.evidenceSpanId),
        },
      ];
    })
    .slice(0, policy.maxMicroPassCandidates);
}
