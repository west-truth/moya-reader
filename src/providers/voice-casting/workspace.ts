import { compareText, voiceCastingIdentity } from './artifact';
import type {
  ImmutableVoiceCastingArtifactV1,
  VoiceCastingWorkspaceDerivedArtifactsV1,
  VoiceCastingWorkspaceUserArtifactsV1,
  VoiceCastingWorkspaceV1,
} from './contracts';
import { VOICE_CASTING_VERSION } from './contracts';
import { assertVoiceCastingState, createEmptyVoiceCastingState } from './state';

export interface VoiceCastingWorkspaceDraftV1 {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly storageRevision?: number;
  readonly userArtifacts: VoiceCastingWorkspaceUserArtifactsV1;
  readonly derivedArtifacts: VoiceCastingWorkspaceDerivedArtifactsV1;
  readonly status?: VoiceCastingWorkspaceV1['status'];
}

function assertRequiredText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
}

function assertStorageRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Voice casting workspace storageRevision must be a nonnegative safe integer');
  }
}

function sortedUniqueText(values: readonly string[], label: string): readonly string[] {
  const sorted = [...values].sort(compareText);
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label} contains duplicate values`);
  for (const value of sorted) assertRequiredText(value, label);
  return sorted;
}

function sortedUniqueArtifacts<T extends ImmutableVoiceCastingArtifactV1>(
  values: readonly T[],
  label: string,
  bookId: string,
  contentRevisionId: string,
): readonly T[] {
  const sorted = [...values].sort((left, right) => compareText(left.id, right.id));
  for (let index = 0; index < sorted.length; index += 1) {
    const value = sorted[index]!;
    if (index > 0 && sorted[index - 1]!.id === value.id) throw new Error(`${label} contains duplicate id ${value.id}`);
    if (value.version !== VOICE_CASTING_VERSION) throw new Error(`${label} contains an unsupported version`);
    if (value.bookId !== bookId || value.contentRevisionId !== contentRevisionId) {
      throw new Error(`${label} contains a cross-book or cross-revision artifact ${value.id}`);
    }
    assertRequiredText(value.id, `${label}.id`);
    assertRequiredText(value.revision, `${label}.revision`);
    assertRequiredText(value.fingerprint, `${label}.fingerprint`);
  }
  return sorted;
}

function normalizeDraft(input: VoiceCastingWorkspaceDraftV1): VoiceCastingWorkspaceDraftV1 {
  assertRequiredText(input.bookId, 'bookId');
  assertRequiredText(input.contentRevisionId, 'contentRevisionId');
  const storageRevision = input.storageRevision ?? 0;
  assertStorageRevision(storageRevision);
  const userEvidence = sortedUniqueArtifacts(
    input.userArtifacts.traitEvidence,
    'userArtifacts.traitEvidence',
    input.bookId,
    input.contentRevisionId,
  );
  if (userEvidence.some((evidence) => evidence.evidenceKind !== 'user')) {
    throw new Error('userArtifacts.traitEvidence may contain only user evidence');
  }
  if (userEvidence.some((evidence) => !evidence.userPinned)) {
    throw new Error('userArtifacts.traitEvidence must contain only user-pinned evidence');
  }
  const derivedEvidence = sortedUniqueArtifacts(
    input.derivedArtifacts.traitEvidence,
    'derivedArtifacts.traitEvidence',
    input.bookId,
    input.contentRevisionId,
  );
  if (derivedEvidence.some((evidence) => evidence.evidenceKind === 'user')) {
    throw new Error('derivedArtifacts.traitEvidence cannot contain user evidence');
  }
  const derivedPools = sortedUniqueArtifacts(
    input.derivedArtifacts.pools,
    'derivedArtifacts.pools',
    input.bookId,
    input.contentRevisionId,
  );
  if (derivedPools.some((pool) => pool.userPinned)) {
    throw new Error('derivedArtifacts.pools cannot contain user-pinned pools');
  }
  const state = input.derivedArtifacts.state;
  assertVoiceCastingState(state);
  if (state.bookId !== input.bookId || state.contentRevisionId !== input.contentRevisionId) {
    throw new Error('Voice casting state does not belong to the workspace revision');
  }
  const pools = sortedUniqueArtifacts(
    input.userArtifacts.pools,
    'userArtifacts.pools',
    input.bookId,
    input.contentRevisionId,
  );
  const overrides = sortedUniqueArtifacts(
    input.userArtifacts.overrides,
    'userArtifacts.overrides',
    input.bookId,
    input.contentRevisionId,
  );
  if (pools.some((pool) => !pool.userPinned) || overrides.some((override) => !override.userPinned)) {
    throw new Error('Voice casting user pools and overrides must be user pinned');
  }
  return {
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    storageRevision,
    status: input.status ?? 'active',
    userArtifacts: {
      voiceProfileIds: sortedUniqueText(input.userArtifacts.voiceProfileIds, 'userArtifacts.voiceProfileIds'),
      pools,
      overrides,
      traitEvidence: userEvidence,
    },
    derivedArtifacts: {
      utterances: sortedUniqueArtifacts(
        input.derivedArtifacts.utterances,
        'derivedArtifacts.utterances',
        input.bookId,
        input.contentRevisionId,
      ),
      importanceProfiles: sortedUniqueArtifacts(
        input.derivedArtifacts.importanceProfiles,
        'derivedArtifacts.importanceProfiles',
        input.bookId,
        input.contentRevisionId,
      ),
      traitEvidence: derivedEvidence,
      traitProfiles: sortedUniqueArtifacts(
        input.derivedArtifacts.traitProfiles,
        'derivedArtifacts.traitProfiles',
        input.bookId,
        input.contentRevisionId,
      ),
      pools: derivedPools,
      state,
    },
  };
}

function workspaceCore(input: VoiceCastingWorkspaceDraftV1) {
  return {
    version: VOICE_CASTING_VERSION,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    storageRevision: input.storageRevision!,
    userArtifacts: input.userArtifacts,
    derivedArtifacts: input.derivedArtifacts,
    userPinned:
      input.userArtifacts.pools.some((pool) => pool.userPinned) ||
      input.userArtifacts.overrides.some((override) => override.userPinned) ||
      input.userArtifacts.traitEvidence.some((evidence) => evidence.userPinned),
  };
}

export function normalizeVoiceCastingWorkspace(input: VoiceCastingWorkspaceDraftV1): VoiceCastingWorkspaceV1 {
  const normalized = normalizeDraft(input);
  const core = workspaceCore(normalized);
  return {
    ...core,
    ...voiceCastingIdentity('voice_casting_workspace', core),
    status: normalized.status ?? 'active',
  };
}

export function createEmptyVoiceCastingWorkspace(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly storageRevision?: number;
}): VoiceCastingWorkspaceV1 {
  return normalizeVoiceCastingWorkspace({
    ...input,
    userArtifacts: { voiceProfileIds: [], pools: [], overrides: [], traitEvidence: [] },
    derivedArtifacts: {
      utterances: [],
      importanceProfiles: [],
      traitEvidence: [],
      traitProfiles: [],
      pools: [],
      state: createEmptyVoiceCastingState(input),
    },
  });
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0)
    throw new Error(`${label} contains unexpected fields: ${unexpected.sort(compareText).join(', ')}`);
}

export function assertVoiceCastingWorkspace(value: unknown): asserts value is VoiceCastingWorkspaceV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Voice casting workspace must be an object');
  const workspace = value as VoiceCastingWorkspaceV1;
  assertExactKeys(
    workspace as unknown as Record<string, unknown>,
    [
      'version',
      'id',
      'bookId',
      'contentRevisionId',
      'revision',
      'fingerprint',
      'storageRevision',
      'userArtifacts',
      'derivedArtifacts',
      'status',
      'userPinned',
    ],
    'Voice casting workspace',
  );
  if (
    !workspace.userArtifacts ||
    typeof workspace.userArtifacts !== 'object' ||
    Array.isArray(workspace.userArtifacts)
  ) {
    throw new Error('Voice casting workspace userArtifacts must be an object');
  }
  if (
    !workspace.derivedArtifacts ||
    typeof workspace.derivedArtifacts !== 'object' ||
    Array.isArray(workspace.derivedArtifacts)
  ) {
    throw new Error('Voice casting workspace derivedArtifacts must be an object');
  }
  assertExactKeys(
    workspace.userArtifacts as unknown as Record<string, unknown>,
    ['voiceProfileIds', 'pools', 'overrides', 'traitEvidence'],
    'Voice casting workspace userArtifacts',
  );
  assertExactKeys(
    workspace.derivedArtifacts as unknown as Record<string, unknown>,
    ['utterances', 'importanceProfiles', 'traitEvidence', 'traitProfiles', 'pools', 'state'],
    'Voice casting workspace derivedArtifacts',
  );
  if (
    !Array.isArray(workspace.userArtifacts.voiceProfileIds) ||
    !Array.isArray(workspace.userArtifacts.pools) ||
    !Array.isArray(workspace.userArtifacts.overrides) ||
    !Array.isArray(workspace.userArtifacts.traitEvidence) ||
    !Array.isArray(workspace.derivedArtifacts.utterances) ||
    !Array.isArray(workspace.derivedArtifacts.importanceProfiles) ||
    !Array.isArray(workspace.derivedArtifacts.traitEvidence) ||
    !Array.isArray(workspace.derivedArtifacts.traitProfiles) ||
    !Array.isArray(workspace.derivedArtifacts.pools)
  ) {
    throw new Error('Voice casting workspace artifact collections must be arrays');
  }
  if (workspace.version !== VOICE_CASTING_VERSION || !['active', 'stale'].includes(workspace.status)) {
    throw new Error('Voice casting workspace version or status is invalid');
  }
  assertStorageRevision(workspace.storageRevision);
  const normalized = normalizeVoiceCastingWorkspace({
    bookId: workspace.bookId,
    contentRevisionId: workspace.contentRevisionId,
    storageRevision: workspace.storageRevision,
    userArtifacts: workspace.userArtifacts,
    derivedArtifacts: workspace.derivedArtifacts,
    status: workspace.status,
  });
  const canonicalIds = (rows: readonly { readonly id: string }[]) => rows.map((row) => row.id).join('\u0000');
  if (
    workspace.id !== normalized.id ||
    workspace.revision !== normalized.revision ||
    workspace.fingerprint !== normalized.fingerprint ||
    workspace.userPinned !== normalized.userPinned ||
    workspace.userArtifacts.voiceProfileIds.join('\u0000') !==
      normalized.userArtifacts.voiceProfileIds.join('\u0000') ||
    canonicalIds(workspace.userArtifacts.pools) !== canonicalIds(normalized.userArtifacts.pools) ||
    canonicalIds(workspace.userArtifacts.overrides) !== canonicalIds(normalized.userArtifacts.overrides) ||
    canonicalIds(workspace.userArtifacts.traitEvidence) !== canonicalIds(normalized.userArtifacts.traitEvidence) ||
    canonicalIds(workspace.derivedArtifacts.utterances) !== canonicalIds(normalized.derivedArtifacts.utterances) ||
    canonicalIds(workspace.derivedArtifacts.importanceProfiles) !==
      canonicalIds(normalized.derivedArtifacts.importanceProfiles) ||
    canonicalIds(workspace.derivedArtifacts.traitEvidence) !==
      canonicalIds(normalized.derivedArtifacts.traitEvidence) ||
    canonicalIds(workspace.derivedArtifacts.traitProfiles) !==
      canonicalIds(normalized.derivedArtifacts.traitProfiles) ||
    canonicalIds(workspace.derivedArtifacts.pools) !== canonicalIds(normalized.derivedArtifacts.pools)
  ) {
    throw new Error('Voice casting workspace is not canonical or has an invalid immutable fingerprint');
  }
}
