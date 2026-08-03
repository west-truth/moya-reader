import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { SpeakerSpanV1 } from '@noveldesk/text-core/speaker-attribution';
import type { CandidateMemoryViewV2 } from './candidate-memory';
import { mineCandidateEvidence, type CandidateEvidenceV1 } from './evidence-miner';
import type { SourceMentionInventoryV1 } from './mention-inventory';

export const CANDIDATE_SELECTION_VERSION = 'candidate-selection-v6' as const;

export type CandidateSufficiencyV1 = 'sufficient' | 'insufficient';

export interface CandidateSelectionDecisionV1 {
  readonly version: typeof CANDIDATE_SELECTION_VERSION;
  readonly id: string;
  readonly targetSpanId: string;
  readonly selectedEntityIds: readonly string[];
  readonly hardIncludeEntityIds: readonly string[];
  readonly trimmedEntityIds: readonly string[];
  readonly newFromMentionOrdinals: readonly number[];
  readonly evidence: readonly CandidateEvidenceV1[];
  readonly supportingSourceMentionIds: readonly string[];
  readonly candidateSufficiency: CandidateSufficiencyV1;
  readonly sufficiencyReasonCodes: readonly ('no_grounded_candidate' | 'candidate_hard_cap_exceeded')[];
  readonly requiresWindowSplit: boolean;
  readonly issueCodes: readonly (
    | 'candidate_hard_cap_exceeded'
    | 'candidate_insufficient'
    | 'candidate_missing'
    | 'new_from_mention_available'
    | 'generic_or_group_candidate'
  )[];
  readonly correctCandidateKnown?: boolean;
  readonly fingerprint: string;
}

export function selectSpeakerCandidates(input: {
  readonly targetSpan: SpeakerSpanV1;
  readonly memory: CandidateMemoryViewV2;
  readonly mentionInventory: SourceMentionInventoryV1;
  readonly lockedCharacterId?: string;
  readonly expectedCharacterId?: string;
  readonly maxCandidates?: number;
  readonly hardCap?: number;
}): CandidateSelectionDecisionV1 {
  const maxCandidates = Math.min(24, Math.max(1, Math.floor(input.maxCandidates ?? 16)));
  const hardCap = Math.min(24, Math.max(maxCandidates, Math.floor(input.hardCap ?? 24)));
  const evidence = mineCandidateEvidence(input);
  const hardIncludeEntityIds = evidence.filter((item) => item.hardReasons.length > 0).map((item) => item.entityId);
  const requiresWindowSplit = hardIncludeEntityIds.length > hardCap;
  const soft = evidence.filter((item) => !hardIncludeEntityIds.includes(item.entityId));
  const selectionLimit = Math.max(maxCandidates, hardIncludeEntityIds.length);
  const selectedEntityIds = requiresWindowSplit
    ? []
    : [...hardIncludeEntityIds, ...soft.map((item) => item.entityId)].slice(0, selectionLimit);
  const selectedEntityIdSet = new Set(selectedEntityIds);
  const supportingSourceMentionIds = [
    ...new Set(
      evidence
        .filter((item) => selectedEntityIdSet.has(item.entityId))
        .flatMap((item) => item.supportingSourceMentionIds),
    ),
  ].sort();
  const trimmedEntityIds = requiresWindowSplit
    ? soft.map((item) => item.entityId)
    : soft.map((item) => item.entityId).filter((id) => !selectedEntityIds.includes(id));
  const newFromMentionOrdinals = input.mentionInventory.mentions
    .filter(
      (mention) =>
        mention.spanId === input.targetSpan.id &&
        !mention.characterId &&
        [
          'name',
          'name_variant',
          'title_name',
          'address_name',
          'generic_role',
          'role_description',
          'group_entity',
        ].includes(mention.type),
    )
    .map((mention) => mention.ordinal);
  const expectedEntity = input.expectedCharacterId
    ? input.memory.entities.find((entity) => entity.characterId === input.expectedCharacterId)
    : undefined;
  const correctCandidateKnown = input.expectedCharacterId
    ? Boolean(expectedEntity && selectedEntityIds.includes(expectedEntity.entityId))
    : undefined;
  const sufficiencyReasonCodes: CandidateSelectionDecisionV1['sufficiencyReasonCodes'][number][] = [];
  if (requiresWindowSplit) sufficiencyReasonCodes.push('candidate_hard_cap_exceeded');
  if (!requiresWindowSplit && selectedEntityIds.length === 0) sufficiencyReasonCodes.push('no_grounded_candidate');
  const candidateSufficiency: CandidateSufficiencyV1 =
    sufficiencyReasonCodes.length === 0 ? 'sufficient' : 'insufficient';
  const issueCodes: CandidateSelectionDecisionV1['issueCodes'][number][] = [];
  if (requiresWindowSplit) issueCodes.push('candidate_hard_cap_exceeded');
  if (candidateSufficiency === 'insufficient') issueCodes.push('candidate_insufficient');
  if (correctCandidateKnown === false) issueCodes.push('candidate_missing');
  if (newFromMentionOrdinals.length > 0) issueCodes.push('new_from_mention_available');
  if (
    selectedEntityIds.some((id) => {
      const entity = input.memory.entities.find((item) => item.entityId === id);
      return entity?.entityKind === 'ephemeral' || entity?.entityKind === 'group';
    })
  ) {
    issueCodes.push('generic_or_group_candidate');
  }
  const core = {
    version: CANDIDATE_SELECTION_VERSION,
    targetSpanId: input.targetSpan.id,
    selectedEntityIds,
    hardIncludeEntityIds,
    trimmedEntityIds,
    newFromMentionOrdinals,
    evidence,
    supportingSourceMentionIds,
    candidateSufficiency,
    sufficiencyReasonCodes,
    requiresWindowSplit,
    issueCodes,
    correctCandidateKnown,
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('candidate_selection', [input.memory.id, input.targetSpan.id, fingerprint]),
    fingerprint,
  };
}
