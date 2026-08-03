import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { assertNarrativeInterval, compareText, voiceCastingIdentity } from './artifact';
import { allocateVoicePools } from './allocator';
import type { VoiceCastingAllocationInputV1 } from './allocator';
import type { VoiceAssignmentOverrideV1, VoiceCastingStateV1 } from './contracts';
import { VOICE_CASTING_VERSION } from './contracts';

function collectionRevision(values: readonly { readonly fingerprint: string }[]): string {
  return structuredIntegrityHash([...values].map((value) => value.fingerprint).sort());
}

export function createVoiceAssignmentOverride(
  input: Omit<VoiceAssignmentOverrideV1, 'version' | 'id' | 'revision' | 'fingerprint' | 'userPinned'>,
): VoiceAssignmentOverrideV1 {
  assertNarrativeInterval(input);
  const core = { version: VOICE_CASTING_VERSION, ...input, userPinned: true as const };
  return { ...core, ...voiceCastingIdentity('voice_assignment_override', core) };
}

export function assertVoiceCastingState(value: unknown): asserts value is VoiceCastingStateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Voice casting state must be an object');
  const state = value as VoiceCastingStateV1;
  if (
    state.version !== VOICE_CASTING_VERSION ||
    !['staging', 'active', 'stale'].includes(state.status) ||
    !Array.isArray(state.assignments) ||
    !Array.isArray(state.reviews)
  ) {
    throw new Error('Voice casting state version, status, or collections are invalid');
  }
  const assertCanonicalArtifacts = (
    rows: readonly { readonly id: string; readonly bookId: string; readonly contentRevisionId: string }[],
    label: string,
  ) => {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (row.bookId !== state.bookId || row.contentRevisionId !== state.contentRevisionId) {
        throw new Error(`${label} contains a cross-book or cross-revision artifact`);
      }
      if (index > 0 && compareText(rows[index - 1]!.id, row.id) >= 0) {
        throw new Error(`${label} must have unique ids in canonical order`);
      }
    }
  };
  assertCanonicalArtifacts(state.assignments, 'Voice casting state assignments');
  assertCanonicalArtifacts(state.reviews, 'Voice casting state reviews');
  const core = {
    version: VOICE_CASTING_VERSION,
    bookId: state.bookId,
    contentRevisionId: state.contentRevisionId,
    importanceRevision: state.importanceRevision,
    traitRevision: state.traitRevision,
    poolRevision: state.poolRevision,
    voiceProfileRevision: state.voiceProfileRevision,
    assignmentRevision: state.assignmentRevision,
    assignments: state.assignments,
    reviews: state.reviews,
    userPinned: state.userPinned,
  };
  const expected = voiceCastingIdentity('voice_casting_state', core);
  if (state.id !== expected.id || state.revision !== expected.revision || state.fingerprint !== expected.fingerprint) {
    throw new Error('Voice casting state has an invalid immutable fingerprint');
  }
}

export function createEmptyVoiceCastingState(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly status?: VoiceCastingStateV1['status'];
}): VoiceCastingStateV1 {
  const emptyRevision = structuredIntegrityHash([]);
  const core = {
    version: VOICE_CASTING_VERSION,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    importanceRevision: emptyRevision,
    traitRevision: emptyRevision,
    poolRevision: emptyRevision,
    voiceProfileRevision: emptyRevision,
    assignmentRevision: emptyRevision,
    assignments: [] as const,
    reviews: [] as const,
    userPinned: false,
  };
  return { ...core, ...voiceCastingIdentity('voice_casting_state', core), status: input.status ?? 'staging' };
}

export function computeVoiceCastingState(input: VoiceCastingAllocationInputV1): VoiceCastingStateV1 {
  const allocation = allocateVoicePools(input);
  const importanceRevision = collectionRevision(input.importanceProfiles);
  const traitRevision = collectionRevision(input.traitProfiles);
  const poolRevision = collectionRevision(input.pools);
  const voiceProfileRevision = structuredIntegrityHash(
    [...input.voiceProfiles]
      .map((profile) => ({
        id: profile.id,
        providerId: profile.providerId,
        providerModel: profile.providerModel,
        providerVoiceId: profile.providerVoiceId,
        speed: profile.speed,
        pitch: profile.pitch,
        tone: profile.tone,
        emotionPolicy: profile.emotionPolicy,
        providerOptions: profile.providerOptions,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
  const assignmentRevision = collectionRevision(allocation.assignments);
  const core = {
    version: VOICE_CASTING_VERSION,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    importanceRevision,
    traitRevision,
    poolRevision,
    voiceProfileRevision,
    assignmentRevision,
    assignments: allocation.assignments,
    reviews: allocation.reviews,
    userPinned: allocation.assignments.some((assignment) => assignment.userPinned),
  };
  return { ...core, ...voiceCastingIdentity('voice_casting_state', core), status: 'active' };
}
