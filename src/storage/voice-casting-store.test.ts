import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { integrityHash } from '../domain/id-hash-contract';
import type { LabeledSegment } from '../domain/types';
import { createAcceptedSpeakerProvenance } from '../providers/speaker-attribution/accepted-speaker-provenance';
import {
  createEmptyVoiceCastingWorkspace,
  createVoiceAssignmentOverride,
  createVoicePoolDefinition,
  createVoiceTraitEvidence,
  normalizeVoiceCastingWorkspace,
} from '../providers/voice-casting';
import { transactionDone } from './indexeddb-transaction';
import { openReaderDb, READER_DB_VERSION, resetReaderDbForTests } from './reader-database';
import { replaceAcceptedSpeakerProvenanceForParagraphs } from './speaker-workflow-store';
import { VOICE_CASTING_STORES } from './voice-casting-schema';
import { listSyncOutbox } from './sync-event-store';
import {
  getVoiceCastingWorkspace,
  listAcceptedSpeakerUtterances,
  saveVoiceCastingWorkspace,
  VoiceCastingRevisionConflictError,
} from './voice-casting-store';

const bookId = 'book_1';
const contentRevisionId = 'content_revision_1';
const chapterId = 'chapter_1';
const paragraphId = 'paragraph_1';

function workspace(storageRevision: number, revisionId = contentRevisionId) {
  return createEmptyVoiceCastingWorkspace({ bookId, contentRevisionId: revisionId, storageRevision });
}

function userAuthoredWorkspace(storageRevision: number) {
  const empty = workspace(storageRevision);
  const pool = createVoicePoolDefinition({
    bookId,
    contentRevisionId,
    providerId: 'system',
    key: 'minor-neutral',
    voiceProfileIds: ['voice_profile_1'],
    traitFilter: {},
    narratorExcluded: true,
    status: 'active',
    userPinned: true,
  });
  const override = createVoiceAssignmentOverride({
    bookId,
    contentRevisionId,
    speakerEntityId: 'speaker_entity_1',
    voiceIdentityId: 'voice_identity_1',
    voiceProfileId: 'voice_profile_1',
    reasonCode: 'user_selection',
    effectiveFromOrder: 1,
    effectiveFromSceneId: 'scene_1',
    status: 'active',
  });
  const traitEvidence = createVoiceTraitEvidence({
    bookId,
    contentRevisionId,
    speakerEntityId: 'speaker_entity_1',
    sceneId: 'scene_1',
    narrativeOrder: 1,
    evidenceSpanId: 'span_user_1',
    evidenceKind: 'user',
    proposedTraits: { ageBand: 'adult' },
    confidence: 1,
    status: 'active',
    userPinned: true,
  });
  return normalizeVoiceCastingWorkspace({
    bookId,
    contentRevisionId,
    storageRevision,
    userArtifacts: {
      voiceProfileIds: ['voice_profile_1'],
      pools: [pool],
      overrides: [override],
      traitEvidence: [traitEvidence],
    },
    derivedArtifacts: empty.derivedArtifacts,
  });
}

function segment(input: {
  readonly id: string;
  readonly paragraphId?: string;
  readonly startOffset?: number;
  readonly endOffset?: number;
  readonly segmentIndex?: number;
}): LabeledSegment {
  return {
    id: input.id,
    novelId: bookId,
    chapterId,
    paragraphId: input.paragraphId ?? paragraphId,
    segmentIndex: input.segmentIndex ?? 0,
    startOffset: input.startOffset ?? 0,
    endOffset: input.endOffset ?? 10,
    segmentTextHash: integrityHash(`voice-casting:${input.id}`),
    type: 'quoted_dialogue',
    speakerId: 'unknown',
    candidateSpeakers: [],
    listenerIds: [],
    emotion: 'neutral',
    confidence: 0.8,
    isUserCorrected: false,
  };
}

function provenance(input: {
  readonly segmentId: string;
  readonly speakerEntityId: string;
  readonly narrativeOrder?: number;
}) {
  return createAcceptedSpeakerProvenance(
    {
      bookId,
      contentRevisionId,
      chapterId,
      paragraphId,
      segmentId: input.segmentId,
      sourceSpanId: `span_${input.segmentId}`,
      sceneId: 'scene_1',
      narrativeOrder: input.narrativeOrder ?? 1,
      speakerEntityId: input.speakerEntityId,
      canonicalSpeakerId: 'unknown',
      resolutionKind: 'provider_new_mention',
      sourceManifestFingerprint: 'manifest_1',
      confidence: 0.8,
    },
    `artifact_${input.segmentId}`,
    '2026-07-13T00:00:00.000Z',
  );
}

async function putSegments(rows: readonly LabeledSegment[]): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction('segments', 'readwrite');
  const done = transactionDone(tx);
  for (const row of rows) tx.objectStore('segments').put(row);
  await done;
}

async function putAcceptedRows(rows: ReturnType<typeof provenance>[]): Promise<void> {
  await replaceAcceptedSpeakerProvenanceForParagraphs({
    bookId,
    contentRevisionId,
    chapterId,
    paragraphIds: [paragraphId],
    rows,
  });
}

describe('voice casting IndexedDB persistence', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('keeps the voice casting store and unique novel index after later database upgrades', async () => {
    const db = await openReaderDb();
    expect(READER_DB_VERSION).toBeGreaterThanOrEqual(31);
    expect(db.version).toBe(READER_DB_VERSION);
    expect(db.objectStoreNames.contains(VOICE_CASTING_STORES.states)).toBe(true);

    const tx = db.transaction(VOICE_CASTING_STORES.states, 'readonly');
    const done = transactionDone(tx);
    const store = tx.objectStore(VOICE_CASTING_STORES.states);
    expect(store.indexNames.contains('novelId')).toBe(true);
    expect(store.index('novelId').unique).toBe(true);
    await done;
  });

  it('returns undefined, then roundtrips an exact canonical revision-one workspace', async () => {
    expect(await getVoiceCastingWorkspace(bookId)).toBeUndefined();
    const first = workspace(1);

    await saveVoiceCastingWorkspace({ workspace: first, expectedStorageRevision: 0 });

    expect(await getVoiceCastingWorkspace(bookId)).toEqual(first);
  });

  it('atomically enqueues only the user-authored projection with a workspace save', async () => {
    const first = userAuthoredWorkspace(1);

    await saveVoiceCastingWorkspace({ workspace: first, expectedStorageRevision: 0 });

    const outbox = await listSyncOutbox('pending');
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.event).toMatchObject({
      type: 'voice_casting_updated',
      novelId: bookId,
      revision: {
        entityType: 'voice_casting',
        novelId: bookId,
      },
      payload: {
        version: 'voice-casting-v1',
        contentRevisionId,
        storageRevision: 1,
        userArtifacts: first.userArtifacts,
      },
    });
    expect(outbox[0]?.event.payload).not.toHaveProperty('derivedArtifacts');
    expect(outbox[0]?.event.payload).not.toHaveProperty('state');
  });

  it('rejects stale CAS without replacing the persisted workspace', async () => {
    const first = workspace(1);
    const staleReplacement = workspace(1, 'content_revision_stale');
    await saveVoiceCastingWorkspace({ workspace: first, expectedStorageRevision: 0 });

    let conflict: unknown;
    try {
      await saveVoiceCastingWorkspace({ workspace: staleReplacement, expectedStorageRevision: 0 });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(VoiceCastingRevisionConflictError);
    expect(conflict).toMatchObject({
      name: 'VoiceCastingRevisionConflictError',
      expectedRevision: 0,
      actualRevision: 1,
    });
    expect(await getVoiceCastingWorkspace(bookId)).toEqual(first);
    expect(await listSyncOutbox('pending')).toHaveLength(1);
  });

  it('advances a workspace by exactly one storage revision', async () => {
    await saveVoiceCastingWorkspace({ workspace: workspace(1), expectedStorageRevision: 0 });

    await expect(saveVoiceCastingWorkspace({ workspace: workspace(3), expectedStorageRevision: 1 })).rejects.toThrow(
      /advance storage revision exactly once/i,
    );

    const second = workspace(2);
    await saveVoiceCastingWorkspace({ workspace: second, expectedStorageRevision: 1 });
    expect(await getVoiceCastingWorkspace(bookId)).toEqual(second);
  });

  it('joins accepted provenance to its labeled segment offsets', async () => {
    const accepted = provenance({ segmentId: 'segment_1', speakerEntityId: 'speaker_entity_1' });
    await putAcceptedRows([accepted]);
    await putSegments([segment({ id: accepted.segmentId, startOffset: 4, endOffset: 17 })]);

    expect(await listAcceptedSpeakerUtterances({ bookId, contentRevisionId, chapterId })).toEqual([
      expect.objectContaining({
        segmentId: accepted.segmentId,
        acceptedProvenanceId: accepted.id,
        speakerEntityId: 'speaker_entity_1',
        canonicalSpeakerId: 'unknown',
        sourceStartOffset: 4,
        sourceEndOffset: 17,
        spokenCharacterCount: 13,
      }),
    ]);
  });

  it('keeps canonical unknown rows with distinct speaker entities separate', async () => {
    const first = provenance({ segmentId: 'segment_1', speakerEntityId: 'speaker_entity_1', narrativeOrder: 1 });
    const second = provenance({ segmentId: 'segment_2', speakerEntityId: 'speaker_entity_2', narrativeOrder: 2 });
    await putAcceptedRows([first, second]);
    await putSegments([
      segment({ id: first.segmentId, segmentIndex: 0 }),
      segment({ id: second.segmentId, segmentIndex: 1 }),
    ]);

    const utterances = await listAcceptedSpeakerUtterances({ bookId, contentRevisionId });
    expect(
      utterances.map(({ canonicalSpeakerId, speakerEntityId }) => ({ canonicalSpeakerId, speakerEntityId })),
    ).toEqual([
      { canonicalSpeakerId: 'unknown', speakerEntityId: 'speaker_entity_1' },
      { canonicalSpeakerId: 'unknown', speakerEntityId: 'speaker_entity_2' },
    ]);
  });

  it.each([
    { integrityCase: 'missing', storedSegment: undefined },
    {
      integrityCase: 'mismatched',
      storedSegment: segment({ id: 'segment_integrity', paragraphId: 'paragraph_other' }),
    },
  ])(
    'rejects $integrityCase segment integrity instead of projecting an assignment source',
    async ({ storedSegment }) => {
      const accepted = provenance({ segmentId: 'segment_integrity', speakerEntityId: 'speaker_entity_integrity' });
      await putAcceptedRows([accepted]);
      if (storedSegment) await putSegments([storedSegment]);

      await expect(listAcceptedSpeakerUtterances({ bookId, contentRevisionId })).rejects.toThrow(
        `Accepted speaker provenance ${accepted.id} has no matching labeled segment`,
      );
    },
  );
});
