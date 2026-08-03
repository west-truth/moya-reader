import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';

export const ACCEPTED_SPEAKER_PROVENANCE_VERSION = 'accepted-speaker-provenance-v1' as const;

export type SpeakerResolutionKindV1 =
  'deterministic' | 'provider_candidate' | 'provider_new_mention' | 'unresolved' | 'manual_review';

export interface SpeakerSegmentProvenanceDraftV1 {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly paragraphId: string;
  readonly segmentId: string;
  readonly sourceSpanId: string;
  readonly sceneId: string;
  readonly dialogueBurstId?: string;
  readonly narrativeOrder: number;
  readonly speakerEntityId?: string;
  readonly canonicalSpeakerId: string;
  readonly resolutionKind: SpeakerResolutionKindV1;
  readonly sourceManifestFingerprint: string;
  readonly packetFingerprint?: string;
  readonly temporalSnapshotId?: string;
  readonly sequenceDecisionId?: string;
  readonly confidence: number;
}

export interface AcceptedSpeakerProvenanceV1 extends SpeakerSegmentProvenanceDraftV1 {
  readonly version: typeof ACCEPTED_SPEAKER_PROVENANCE_VERSION;
  readonly id: string;
  readonly artifactId: string;
  readonly status: 'active' | 'superseded' | 'stale';
  readonly staleReason?: string;
  readonly createdAt: string;
  readonly fingerprint: string;
}

export interface ManualReviewSpeakerProvenanceInput {
  readonly draft: SpeakerSegmentProvenanceDraftV1;
  readonly promotedSpeakerId: string;
  readonly speakerEntityIdByCanonicalSpeakerId: Readonly<Record<string, string>>;
  readonly speakerEdited: boolean;
}

const RESOLUTION_KINDS: readonly SpeakerResolutionKindV1[] = [
  'deterministic',
  'provider_candidate',
  'provider_new_mention',
  'unresolved',
  'manual_review',
];

const REQUIRED_DRAFT_TEXT_FIELDS = [
  'bookId',
  'contentRevisionId',
  'chapterId',
  'paragraphId',
  'segmentId',
  'sourceSpanId',
  'sceneId',
  'canonicalSpeakerId',
  'sourceManifestFingerprint',
] as const satisfies readonly (keyof SpeakerSegmentProvenanceDraftV1)[];

const OPTIONAL_DRAFT_TEXT_FIELDS = [
  'dialogueBurstId',
  'speakerEntityId',
  'packetFingerprint',
  'temporalSnapshotId',
  'sequenceDecisionId',
] as const satisfies readonly (keyof SpeakerSegmentProvenanceDraftV1)[];

function assertRequiredText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
}

function assertOptionalText(value: unknown, label: string): asserts value is string | undefined {
  if (value !== undefined) assertRequiredText(value, label);
}

function assertDraft(draft: SpeakerSegmentProvenanceDraftV1): void {
  for (const field of REQUIRED_DRAFT_TEXT_FIELDS) assertRequiredText(draft[field], field);
  for (const field of OPTIONAL_DRAFT_TEXT_FIELDS) assertOptionalText(draft[field], field);
  if (!Number.isSafeInteger(draft.narrativeOrder) || draft.narrativeOrder < 0) {
    throw new Error('narrativeOrder must be a nonnegative safe integer');
  }
  if (!Number.isFinite(draft.confidence) || draft.confidence < 0 || draft.confidence > 1) {
    throw new Error('confidence must be between 0 and 1');
  }
  if (!RESOLUTION_KINDS.includes(draft.resolutionKind)) {
    throw new Error(`Unsupported speaker resolution kind: ${String(draft.resolutionKind)}`);
  }
}

export function assertSpeakerSegmentProvenanceDraft(draft: SpeakerSegmentProvenanceDraftV1): void {
  assertDraft(draft);
}

export function parseSpeakerSegmentProvenanceDrafts(value: unknown): readonly SpeakerSegmentProvenanceDraftV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Speaker segment provenance drafts must be an array');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Speaker segment provenance draft must be an object');
    }
    const draft = item as SpeakerSegmentProvenanceDraftV1;
    assertDraft(draft);
    return draft;
  });
}

function immutableCore(draft: SpeakerSegmentProvenanceDraftV1, artifactId: string) {
  return {
    version: ACCEPTED_SPEAKER_PROVENANCE_VERSION,
    artifactId,
    bookId: draft.bookId,
    contentRevisionId: draft.contentRevisionId,
    chapterId: draft.chapterId,
    paragraphId: draft.paragraphId,
    segmentId: draft.segmentId,
    sourceSpanId: draft.sourceSpanId,
    sceneId: draft.sceneId,
    dialogueBurstId: draft.dialogueBurstId,
    narrativeOrder: draft.narrativeOrder,
    speakerEntityId: draft.speakerEntityId,
    canonicalSpeakerId: draft.canonicalSpeakerId,
    resolutionKind: draft.resolutionKind,
    sourceManifestFingerprint: draft.sourceManifestFingerprint,
    packetFingerprint: draft.packetFingerprint,
    temporalSnapshotId: draft.temporalSnapshotId,
    sequenceDecisionId: draft.sequenceDecisionId,
    confidence: draft.confidence,
  };
}

function immutableIdentity(core: ReturnType<typeof immutableCore>) {
  const fingerprint = structuredIntegrityHash(core);
  return {
    id: persistentId128('accepted_speaker_provenance', [core.artifactId, fingerprint]),
    fingerprint,
  };
}

function assertStatus(row: Pick<AcceptedSpeakerProvenanceV1, 'status' | 'staleReason'>): void {
  if (!['active', 'superseded', 'stale'].includes(row.status)) {
    throw new Error(`Unsupported accepted speaker provenance status: ${String(row.status)}`);
  }
  if (row.status === 'stale') {
    assertRequiredText(row.staleReason, 'staleReason');
  } else if (row.staleReason !== undefined) {
    throw new Error(`${row.status} accepted speaker provenance cannot have a stale reason`);
  }
}

export function createAcceptedSpeakerProvenance(
  draft: SpeakerSegmentProvenanceDraftV1,
  artifactId: string,
  createdAt = new Date().toISOString(),
): AcceptedSpeakerProvenanceV1 {
  assertDraft(draft);
  assertRequiredText(artifactId, 'artifactId');
  assertRequiredText(createdAt, 'createdAt');
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('createdAt must be a valid date-time');
  const core = immutableCore(draft, artifactId);
  return {
    ...core,
    ...immutableIdentity(core),
    status: 'active',
    createdAt,
  };
}

export function assertAcceptedSpeakerProvenance(row: AcceptedSpeakerProvenanceV1): void {
  if (row.version !== ACCEPTED_SPEAKER_PROVENANCE_VERSION) {
    throw new Error(`Unsupported accepted speaker provenance version: ${String(row.version)}`);
  }
  assertDraft(row);
  assertRequiredText(row.id, 'id');
  assertRequiredText(row.artifactId, 'artifactId');
  assertRequiredText(row.createdAt, 'createdAt');
  assertRequiredText(row.fingerprint, 'fingerprint');
  if (!Number.isFinite(Date.parse(row.createdAt))) throw new Error('createdAt must be a valid date-time');
  assertStatus(row);
  const expected = immutableIdentity(immutableCore(row, row.artifactId));
  if (row.fingerprint !== expected.fingerprint || row.id !== expected.id) {
    throw new Error(`Accepted speaker provenance ${row.id} has invalid immutable core`);
  }
}

export function transitionAcceptedSpeakerProvenance(
  row: AcceptedSpeakerProvenanceV1,
  status: 'superseded' | 'stale',
  staleReason?: string,
): AcceptedSpeakerProvenanceV1 {
  assertAcceptedSpeakerProvenance(row);
  if (row.status !== 'active') {
    throw new Error(`Cannot transition accepted speaker provenance from ${row.status}`);
  }
  const transitioned = { ...row, status, staleReason };
  assertStatus(transitioned);
  return transitioned;
}

export function assertNoDuplicateActiveSpeakerProvenance(rows: readonly AcceptedSpeakerProvenanceV1[]): void {
  const activeKeys = new Set<string>();
  for (const row of rows) {
    assertAcceptedSpeakerProvenance(row);
    if (row.status !== 'active') continue;
    const key = structuredIntegrityHash([row.contentRevisionId, row.segmentId]);
    if (activeKeys.has(key)) {
      throw new Error(
        `Duplicate active accepted speaker provenance for revision ${row.contentRevisionId}, segment ${row.segmentId}`,
      );
    }
    activeKeys.add(key);
  }
}

export function createManualReviewSpeakerProvenanceDraft(
  input: ManualReviewSpeakerProvenanceInput,
): SpeakerSegmentProvenanceDraftV1 {
  assertDraft(input.draft);
  assertRequiredText(input.promotedSpeakerId, 'promotedSpeakerId');

  let speakerEntityId: string | undefined;
  if (!input.speakerEdited) {
    speakerEntityId = input.draft.speakerEntityId;
  } else if (input.promotedSpeakerId === 'unknown') {
    speakerEntityId = undefined;
  } else if (input.promotedSpeakerId === 'narrator' || input.promotedSpeakerId === 'system') {
    speakerEntityId = input.promotedSpeakerId;
  } else {
    speakerEntityId = input.speakerEntityIdByCanonicalSpeakerId[input.promotedSpeakerId];
    assertRequiredText(speakerEntityId, `speaker entity for ${input.promotedSpeakerId}`);
  }

  return {
    ...input.draft,
    canonicalSpeakerId: input.promotedSpeakerId,
    resolutionKind: 'manual_review',
    speakerEntityId,
  };
}
