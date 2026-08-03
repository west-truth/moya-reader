import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { SpeakerArtifactDependencyV1 } from '../speaker-attribution/artifact-dependency';
import { createSpeakerArtifactDependency } from '../speaker-attribution/artifact-dependency';
import { compareText } from './artifact';
import type { VoiceCastingAllocationInputV1 } from './allocator';
import type { VoiceCastingRecomputeChangeV1, VoiceCastingRecomputePlanV1, VoiceCastingStateV1 } from './contracts';
import { computeVoiceCastingState } from './state';

export function planVoiceCastingRecompute(
  changes: readonly VoiceCastingRecomputeChangeV1[],
): VoiceCastingRecomputePlanV1 {
  const normalized = [...changes].sort(
    (left, right) => compareText(left.kind, right.kind) || compareText(left.artifactId, right.artifactId),
  );
  const hasSource = normalized.some((change) => change.kind === 'source');
  const hasSpeaker = normalized.some((change) => change.kind === 'speaker_label');
  const affectedSpeakerEntityIds = [...new Set(normalized.flatMap((change) => change.speakerEntityIds ?? []))].sort(
    compareText,
  );
  const starts = normalized
    .map((change) => change.scopeStartOrder)
    .filter((value): value is number => value !== undefined);
  const ends = normalized.map((change) => change.scopeEndOrder).filter((value): value is number => value !== undefined);
  const core = {
    level: hasSource ? ('L0_source' as const) : hasSpeaker ? ('L3_speaker' as const) : ('L4_voice' as const),
    invalidateVoiceAssignments: normalized.length > 0,
    invalidateTts: normalized.length > 0,
    recallSpeakerProvider: hasSource || hasSpeaker,
    affectedSpeakerEntityIds,
    changedArtifactIds: [...new Set(normalized.map((change) => change.artifactId))].sort(compareText),
    scopeStartOrder: starts.length > 0 ? Math.min(...starts) : undefined,
    scopeEndOrder: ends.length > 0 ? Math.max(...ends) : undefined,
  };
  return { ...core, fingerprint: structuredIntegrityHash({ changes: normalized, plan: core }) };
}

export function recomputeVoiceCastingState(input: {
  readonly casting: VoiceCastingAllocationInputV1;
  readonly changes: readonly VoiceCastingRecomputeChangeV1[];
}): { readonly state: VoiceCastingStateV1; readonly plan: VoiceCastingRecomputePlanV1 } {
  return {
    state: computeVoiceCastingState(input.casting),
    plan: planVoiceCastingRecompute(input.changes),
  };
}

export function createVoiceCastingDependencyRows(input: {
  readonly state: VoiceCastingStateV1;
  readonly createdAt?: string;
}): readonly SpeakerArtifactDependencyV1[] {
  const common = {
    bookId: input.state.bookId,
    contentRevisionId: input.state.contentRevisionId,
    level: 'L4_voice' as const,
    createdAt: input.createdAt,
  };
  const assignments = input.state.assignments.map((assignment) =>
    createSpeakerArtifactDependency({
      ...common,
      artifactId: assignment.id,
      artifactKind: 'voice_assignment',
      dependencyIds: [
        input.state.importanceRevision,
        input.state.traitRevision,
        input.state.poolRevision,
        input.state.voiceProfileRevision,
      ],
    }),
  );
  const state = createSpeakerArtifactDependency({
    ...common,
    artifactId: input.state.id,
    artifactKind: 'voice_casting_state',
    dependencyIds: input.state.assignments.map((assignment) => assignment.id),
  });
  return [...assignments, state].sort((left, right) => compareText(left.id, right.id));
}
