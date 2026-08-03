import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';

interface ReaderVisibleIdentityV1 {
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly sourceRevealAnchorId: string;
  readonly speakerEntityId: string;
  readonly visibleFromNarrativeOrder: number;
  readonly visibleToNarrativeOrder?: number;
  readonly createdAt: string;
  readonly fingerprint: string;
}

export interface SpeakerIdentityEdgeV1 extends ReaderVisibleIdentityV1 {
  readonly version: 'speaker-identity-edge-v1';
  readonly characterId: string;
  readonly confidenceKind: 'human_verified' | 'calibrated' | 'model_score';
  readonly status: 'active' | 'superseded' | 'rejected';
  readonly provenance: 'user_correction' | 'source_evidence' | 'model_hypothesis';
}

export interface SpeakerVoiceIdentityV1 extends ReaderVisibleIdentityV1 {
  readonly version: 'speaker-voice-identity-v1';
  readonly voiceIdentityId: string;
  readonly assignmentKind: 'character_profile' | 'scene_pool' | 'role_fallback';
  readonly userPinned: boolean;
}

type IdentityInterval = Pick<ReaderVisibleIdentityV1, 'visibleFromNarrativeOrder' | 'visibleToNarrativeOrder'>;

type IdentityBaseInput = Pick<
  ReaderVisibleIdentityV1,
  'contentRevisionId' | 'sourceRevealAnchorId' | 'visibleFromNarrativeOrder' | 'visibleToNarrativeOrder'
>;

function assertStableAnchor(label: string, value: string): void {
  if (!value.trim()) throw new Error(`${label} is required for a speaker identity`);
}

function assertNarrativeInterval(interval: IdentityInterval): void {
  const { visibleFromNarrativeOrder: start, visibleToNarrativeOrder: end } = interval;
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new Error('Speaker identity reveal start must be a finite nonnegative integer');
  }
  if (end !== undefined && (!Number.isSafeInteger(end) || end < 0 || end < start)) {
    throw new Error('Speaker identity reveal end must be a finite nonnegative integer at or after its start');
  }
}

function inside(order: number, start: number, end?: number): boolean {
  return Number.isFinite(order) && order >= start && (end === undefined || order <= end);
}

function overlaps(left: IdentityInterval, right: IdentityInterval): boolean {
  return (
    left.visibleFromNarrativeOrder <= (right.visibleToNarrativeOrder ?? Number.POSITIVE_INFINITY) &&
    right.visibleFromNarrativeOrder <= (left.visibleToNarrativeOrder ?? Number.POSITIVE_INFINITY)
  );
}

function speakerEdgeCore(input: Omit<SpeakerIdentityEdgeV1, 'version' | 'id' | 'fingerprint' | 'createdAt'>) {
  return {
    version: 'speaker-identity-edge-v1' as const,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    sourceRevealAnchorId: input.sourceRevealAnchorId,
    speakerEntityId: input.speakerEntityId,
    characterId: input.characterId,
    visibleFromNarrativeOrder: input.visibleFromNarrativeOrder,
    visibleToNarrativeOrder: input.visibleToNarrativeOrder,
    confidenceKind: input.confidenceKind,
    status: input.status,
    provenance: input.provenance,
  };
}

function voiceIdentityCore(input: Omit<SpeakerVoiceIdentityV1, 'version' | 'id' | 'fingerprint' | 'createdAt'>) {
  return {
    version: 'speaker-voice-identity-v1' as const,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    sourceRevealAnchorId: input.sourceRevealAnchorId,
    speakerEntityId: input.speakerEntityId,
    voiceIdentityId: input.voiceIdentityId,
    visibleFromNarrativeOrder: input.visibleFromNarrativeOrder,
    visibleToNarrativeOrder: input.visibleToNarrativeOrder,
    assignmentKind: input.assignmentKind,
    userPinned: input.userPinned,
  };
}

function identityId(
  namespace: 'speaker_identity_edge' | 'speaker_voice_identity',
  input: Pick<ReaderVisibleIdentityV1, 'bookId' | 'contentRevisionId' | 'speakerEntityId' | 'sourceRevealAnchorId'>,
  fingerprint: string,
): string {
  return persistentId128(namespace, [
    input.bookId,
    input.contentRevisionId,
    input.speakerEntityId,
    input.sourceRevealAnchorId,
    fingerprint,
  ]);
}

function assertIdentityBase(row: IdentityBaseInput): void {
  assertStableAnchor('contentRevisionId', row.contentRevisionId);
  assertStableAnchor('sourceRevealAnchorId', row.sourceRevealAnchorId);
  assertNarrativeInterval(row);
}

export function createSpeakerIdentityEdge(
  input: Omit<SpeakerIdentityEdgeV1, 'version' | 'id' | 'fingerprint' | 'createdAt'> & { readonly createdAt?: string },
): SpeakerIdentityEdgeV1 {
  assertIdentityBase(input);
  const core = speakerEdgeCore(input);
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: identityId('speaker_identity_edge', input, fingerprint),
    createdAt: input.createdAt ?? new Date().toISOString(),
    fingerprint,
  };
}

export function createSpeakerVoiceIdentity(
  input: Omit<SpeakerVoiceIdentityV1, 'version' | 'id' | 'fingerprint' | 'createdAt'> & {
    readonly createdAt?: string;
  },
): SpeakerVoiceIdentityV1 {
  assertIdentityBase(input);
  const core = voiceIdentityCore(input);
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: identityId('speaker_voice_identity', input, fingerprint),
    createdAt: input.createdAt ?? new Date().toISOString(),
    fingerprint,
  };
}

export function assertSpeakerIdentityEdge(row: SpeakerIdentityEdgeV1): void {
  assertIdentityBase(row);
  const core = speakerEdgeCore(row);
  const fingerprint = structuredIntegrityHash(core);
  if (row.fingerprint !== fingerprint || row.id !== identityId('speaker_identity_edge', row, fingerprint)) {
    throw new Error(`Speaker identity edge ${row.id} has invalid immutable content`);
  }
}

export function assertSpeakerVoiceIdentity(row: SpeakerVoiceIdentityV1): void {
  assertIdentityBase(row);
  const core = voiceIdentityCore(row);
  const fingerprint = structuredIntegrityHash(core);
  if (row.fingerprint !== fingerprint || row.id !== identityId('speaker_voice_identity', row, fingerprint)) {
    throw new Error(`Speaker voice identity ${row.id} has invalid immutable content`);
  }
}

export function assertNoAmbiguousSpeakerIdentityEdges(edges: readonly SpeakerIdentityEdgeV1[]): void {
  const active = edges.filter((edge) => edge.status === 'active');
  for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
    const left = active[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
      const right = active[rightIndex]!;
      if (
        left.bookId === right.bookId &&
        left.contentRevisionId === right.contentRevisionId &&
        left.speakerEntityId === right.speakerEntityId &&
        left.characterId !== right.characterId &&
        overlaps(left, right)
      ) {
        throw new Error(`Speaker identity mapping for ${left.speakerEntityId} has an ambiguous active interval`);
      }
    }
  }
}

export function assertNoAmbiguousSpeakerVoiceIdentities(identities: readonly SpeakerVoiceIdentityV1[]): void {
  for (let leftIndex = 0; leftIndex < identities.length; leftIndex += 1) {
    const left = identities[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < identities.length; rightIndex += 1) {
      const right = identities[rightIndex]!;
      if (
        left.bookId === right.bookId &&
        left.contentRevisionId === right.contentRevisionId &&
        left.speakerEntityId === right.speakerEntityId &&
        left.userPinned === right.userPinned &&
        left.voiceIdentityId !== right.voiceIdentityId &&
        overlaps(left, right)
      ) {
        throw new Error(`Speaker voice mapping for ${left.speakerEntityId} has an ambiguous active interval`);
      }
    }
  }
}

export function resolveReaderSafeSpeakerIdentity(
  edges: readonly SpeakerIdentityEdgeV1[],
  speakerEntityId: string,
  narrativeOrder: number,
  contentRevisionId?: string,
): string | undefined {
  return edges
    .filter(
      (edge) =>
        edge.speakerEntityId === speakerEntityId &&
        (contentRevisionId === undefined || edge.contentRevisionId === contentRevisionId) &&
        edge.status === 'active' &&
        inside(narrativeOrder, edge.visibleFromNarrativeOrder, edge.visibleToNarrativeOrder),
    )
    .sort((a, b) => b.visibleFromNarrativeOrder - a.visibleFromNarrativeOrder || a.id.localeCompare(b.id))[0]
    ?.characterId;
}

export function resolveReaderSafeVoiceIdentity(
  identities: readonly SpeakerVoiceIdentityV1[],
  speakerEntityId: string,
  narrativeOrder: number,
  contentRevisionId?: string,
): SpeakerVoiceIdentityV1 | undefined {
  return identities
    .filter(
      (identity) =>
        identity.speakerEntityId === speakerEntityId &&
        (contentRevisionId === undefined || identity.contentRevisionId === contentRevisionId) &&
        inside(narrativeOrder, identity.visibleFromNarrativeOrder, identity.visibleToNarrativeOrder),
    )
    .sort(
      (a, b) =>
        Number(b.userPinned) - Number(a.userPinned) ||
        b.visibleFromNarrativeOrder - a.visibleFromNarrativeOrder ||
        a.id.localeCompare(b.id),
    )[0];
}
