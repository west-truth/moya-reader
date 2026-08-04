import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSpeakerArtifactDependency } from '../providers/speaker-attribution/artifact-dependency';
import { createAcceptedSpeakerProvenance } from '../providers/speaker-attribution/accepted-speaker-provenance';
import {
  createSpeakerIdentityEdge,
  createSpeakerVoiceIdentity,
} from '../providers/speaker-attribution/speaker-identity';
import { createSpeakerSequenceDecisionRecord } from '../providers/speaker-attribution/workflow-state';
import { BOOK_DATA_STORES, deleteBookDataInTransaction } from './book-data-cleanup';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb, resetReaderDbForTests } from './reader-database';
import {
  appendSpeakerIdentityEdges,
  appendSpeakerVoiceIdentities,
  listAcceptedSpeakerProvenance,
  listSpeakerArtifactDependencies,
  listSpeakerIdentityEdges,
  listSpeakerSequenceDecisions,
  listSpeakerVoiceIdentities,
  markSpeakerArtifactDependenciesStale,
  putSpeakerArtifactDependencies,
  replaceAcceptedSpeakerProvenanceForParagraphs,
  replaceSpeakerSequenceDecisionsForChapter,
} from './speaker-workflow-store';
import { SPEAKER_WORKFLOW_STORES } from './speaker-workflow-schema';

const bookId = 'book_1';
const contentRevisionId = 'revision_1';
const chapterId = 'chapter_1';

function sequenceRecord(id: string, sceneId: string, selectedSpeakerOrdinal = 0) {
  return createSpeakerSequenceDecisionRecord({
    bookId,
    contentRevisionId,
    chapterId,
    sceneId,
    packetFingerprint: `packet_${sceneId}`,
    decision: {
      version: 'dialogue-sequence-decision-v1',
      id,
      burstOrdinal: 0,
      spanIndexes: [0],
      candidateOrdinals: [[0, 1]],
      selectedSpeakerOrdinals: [selectedSpeakerOrdinal],
      ruleConstraintBits: [0],
      decoderMethod: 'min_cost_path',
      disagreementIndexes: [],
      reviewCodes: [],
      fingerprint: `decision_fingerprint_${id}_${selectedSpeakerOrdinal}`,
    },
  });
}

function dependency() {
  return createSpeakerArtifactDependency({
    bookId,
    contentRevisionId,
    chapterId,
    sceneId: 'scene_1',
    artifactId: 'artifact_1',
    artifactKind: 'speaker_labels',
    level: 'L3_speaker',
    dependencyIds: ['inventory_1'],
    createdAt: '2026-07-13T00:00:00.000Z',
  });
}

function speakerEdge(characterId = 'character_1', sourceRevealAnchorId = 'correction_1') {
  return createSpeakerIdentityEdge({
    bookId,
    contentRevisionId,
    sourceRevealAnchorId,
    speakerEntityId: 'speaker_1',
    characterId,
    visibleFromNarrativeOrder: 10,
    visibleToNarrativeOrder: 20,
    confidenceKind: 'human_verified',
    status: 'active',
    provenance: 'user_correction',
    createdAt: '2026-07-13T00:00:00.000Z',
  });
}

function voiceIdentity(voiceIdentityId = 'voice_1', sourceRevealAnchorId = 'voice_assignment_1') {
  return createSpeakerVoiceIdentity({
    bookId,
    contentRevisionId,
    sourceRevealAnchorId,
    speakerEntityId: 'speaker_1',
    voiceIdentityId,
    visibleFromNarrativeOrder: 10,
    visibleToNarrativeOrder: 20,
    assignmentKind: 'character_profile',
    userPinned: false,
    createdAt: '2026-07-13T00:00:00.000Z',
  });
}

function acceptedProvenance(
  paragraphId: string,
  segmentId: string,
  speakerEntityId: string,
  artifactId = `artifact_${segmentId}`,
) {
  return createAcceptedSpeakerProvenance(
    {
      bookId,
      contentRevisionId,
      chapterId,
      paragraphId,
      segmentId,
      sourceSpanId: `span_${segmentId}`,
      sceneId: 'scene_1',
      narrativeOrder: Number(segmentId.replace(/\D/g, '')) || 0,
      speakerEntityId,
      canonicalSpeakerId: `canonical_${speakerEntityId}`,
      resolutionKind: 'provider_new_mention',
      sourceManifestFingerprint: 'manifest_1',
      confidence: 0.8,
    },
    artifactId,
    '2026-07-13T00:00:00.000Z',
  );
}

describe('speaker workflow IndexedDB correctness', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('merges multiple chapter windows idempotently and preserves immutable conflicts', async () => {
    const firstWindow = sequenceRecord('decision_1', 'scene_1');
    const secondWindow = sequenceRecord('decision_2', 'scene_2');
    await replaceSpeakerSequenceDecisionsForChapter({
      contentRevisionId,
      chapterId,
      records: [firstWindow],
    });
    await replaceSpeakerSequenceDecisionsForChapter({
      contentRevisionId,
      chapterId,
      records: [secondWindow],
    });
    await replaceSpeakerSequenceDecisionsForChapter({
      contentRevisionId,
      chapterId,
      records: [firstWindow, secondWindow],
    });

    expect((await listSpeakerSequenceDecisions(contentRevisionId, chapterId)).map((row) => row.id).sort()).toEqual([
      'decision_1',
      'decision_2',
    ]);

    await expect(
      replaceSpeakerSequenceDecisionsForChapter({
        contentRevisionId,
        chapterId,
        records: [sequenceRecord('decision_1', 'scene_1', 1)],
      }),
    ).rejects.toThrow(/immutable content/i);
    expect(await listSpeakerSequenceDecisions(contentRevisionId, chapterId)).toHaveLength(2);
  });

  it('applies a monotonic stale transition without changing dependency lineage', async () => {
    const active = dependency();
    await putSpeakerArtifactDependencies([active]);
    await expect(
      putSpeakerArtifactDependencies([{ ...active, dependencyIds: ['tampered_inventory'] }]),
    ).rejects.toThrow(/invalid immutable lineage/i);
    expect(
      await markSpeakerArtifactDependenciesStale({
        contentRevisionId,
        rowIds: [active.id, active.id],
        staleReason: 'inventory changed',
      }),
    ).toBe(1);
    await putSpeakerArtifactDependencies([active]);

    const [stored] = await listSpeakerArtifactDependencies(contentRevisionId);
    expect(stored).toMatchObject({
      id: active.id,
      fingerprint: active.fingerprint,
      status: 'stale',
      staleReason: 'inventory changed',
      createdAt: active.createdAt,
    });
  });

  it('keeps identity retries idempotent and rejects ambiguous overlaps atomically', async () => {
    const first = speakerEdge();
    const retry = createSpeakerIdentityEdge({
      ...first,
      createdAt: '2026-07-13T01:00:00.000Z',
    });
    await appendSpeakerIdentityEdges([first, retry]);
    expect(await listSpeakerIdentityEdges(bookId)).toEqual([first]);

    await expect(appendSpeakerIdentityEdges([speakerEdge('character_2', 'correction_2')])).rejects.toThrow(
      /ambiguous active interval/i,
    );
    expect(await listSpeakerIdentityEdges(bookId)).toEqual([first]);

    const fallback = voiceIdentity();
    await appendSpeakerVoiceIdentities([fallback]);
    await expect(appendSpeakerVoiceIdentities([voiceIdentity('voice_2', 'voice_assignment_2')])).rejects.toThrow(
      /ambiguous active interval/i,
    );
    expect(await listSpeakerVoiceIdentities(bookId)).toEqual([fallback]);
  });

  it('roundtrips separate accepted provenance rows for noncanonical speaker entities', async () => {
    const first = acceptedProvenance('paragraph_1', 'segment_1', 'speaker_entity_candidate_1');
    const second = acceptedProvenance('paragraph_1', 'segment_2', 'speaker_entity_candidate_2');

    await replaceAcceptedSpeakerProvenanceForParagraphs({
      bookId,
      contentRevisionId,
      chapterId,
      paragraphIds: ['paragraph_1'],
      rows: [first, second],
    });

    expect(await listAcceptedSpeakerProvenance({ bookId, contentRevisionId, chapterId, activeOnly: true })).toEqual([
      first,
      second,
    ]);
  });

  it('replaces accepted provenance only in selected paragraphs and is idempotent', async () => {
    const replaced = acceptedProvenance('paragraph_1', 'segment_1', 'speaker_entity_candidate_1');
    const preserved = acceptedProvenance('paragraph_2', 'segment_2', 'speaker_entity_candidate_2');
    await replaceAcceptedSpeakerProvenanceForParagraphs({
      bookId,
      contentRevisionId,
      chapterId,
      paragraphIds: ['paragraph_1', 'paragraph_2'],
      rows: [replaced, preserved],
    });

    const replacement = acceptedProvenance(
      'paragraph_1',
      'segment_1',
      'speaker_entity_candidate_3',
      'artifact_replacement',
    );
    const retry = {
      bookId,
      contentRevisionId,
      chapterId,
      paragraphIds: ['paragraph_1'],
      rows: [replacement],
    } as const;
    await replaceAcceptedSpeakerProvenanceForParagraphs(retry);
    await replaceAcceptedSpeakerProvenanceForParagraphs(retry);

    const rows = await listAcceptedSpeakerProvenance({ bookId, contentRevisionId, chapterId });
    expect(rows).toEqual(expect.arrayContaining([{ ...replaced, status: 'superseded' }, preserved, replacement]));
    expect(rows).toHaveLength(3);
  });

  it('rejects accepted provenance conflicts atomically', async () => {
    const existing = acceptedProvenance('paragraph_1', 'segment_1', 'speaker_entity_candidate_1');
    const preserved = acceptedProvenance('paragraph_2', 'segment_2', 'speaker_entity_candidate_2');
    await replaceAcceptedSpeakerProvenanceForParagraphs({
      bookId,
      contentRevisionId,
      chapterId,
      paragraphIds: ['paragraph_1', 'paragraph_2'],
      rows: [existing, preserved],
    });
    const duplicateSegment = acceptedProvenance(
      'paragraph_1',
      'segment_2',
      'speaker_entity_candidate_3',
      'artifact_duplicate',
    );

    await expect(
      replaceAcceptedSpeakerProvenanceForParagraphs({
        bookId,
        contentRevisionId,
        chapterId,
        paragraphIds: ['paragraph_1'],
        rows: [duplicateSegment],
      }),
    ).rejects.toThrow(/duplicate active/i);
    expect(await listAcceptedSpeakerProvenance({ bookId, contentRevisionId, activeOnly: true })).toEqual(
      expect.arrayContaining([existing, preserved]),
    );

    const immutableCollision = acceptedProvenance(
      'paragraph_1',
      'segment_3',
      'speaker_entity_candidate_4',
      'artifact_collision',
    );
    const db = await openReaderDb();
    const collisionTx = db.transaction(SPEAKER_WORKFLOW_STORES.acceptedSpeakerProvenance, 'readwrite');
    const collisionDone = transactionDone(collisionTx);
    collisionTx.objectStore(SPEAKER_WORKFLOW_STORES.acceptedSpeakerProvenance).add({
      ...immutableCollision,
      fingerprint: 'persisted_collision',
      status: 'superseded',
    });
    await collisionDone;

    await expect(
      replaceAcceptedSpeakerProvenanceForParagraphs({
        bookId,
        contentRevisionId,
        chapterId,
        paragraphIds: ['paragraph_1'],
        rows: [immutableCollision],
      }),
    ).rejects.toThrow(/immutable (?:core|content)/i);
    const cleanupTx = db.transaction(SPEAKER_WORKFLOW_STORES.acceptedSpeakerProvenance, 'readwrite');
    const cleanupDone = transactionDone(cleanupTx);
    cleanupTx.objectStore(SPEAKER_WORKFLOW_STORES.acceptedSpeakerProvenance).delete(immutableCollision.id);
    await cleanupDone;
    expect(await listAcceptedSpeakerProvenance({ bookId, contentRevisionId, activeOnly: true })).toEqual(
      expect.arrayContaining([existing, preserved]),
    );
  });

  it('purges every speaker workflow store and does not enqueue derived rows for sync', async () => {
    const sequence = sequenceRecord('decision_1', 'scene_1');
    const lineage = dependency();
    await replaceSpeakerSequenceDecisionsForChapter({ contentRevisionId, chapterId, records: [sequence] });
    await putSpeakerArtifactDependencies([lineage]);
    await appendSpeakerIdentityEdges([speakerEdge()]);
    await appendSpeakerVoiceIdentities([voiceIdentity()]);
    await replaceAcceptedSpeakerProvenanceForParagraphs({
      bookId,
      contentRevisionId,
      chapterId,
      paragraphIds: ['paragraph_1'],
      rows: [acceptedProvenance('paragraph_1', 'segment_1', 'speaker_entity_candidate_1')],
    });

    expect(Object.values(SPEAKER_WORKFLOW_STORES).every((name) => BOOK_DATA_STORES.includes(name))).toBe(true);
    const db = await openReaderDb();
    const syncTx = db.transaction('sync_outbox', 'readonly');
    expect(await requestToPromise<unknown[]>(syncTx.objectStore('sync_outbox').getAll())).toEqual([]);

    const purgeTx = db.transaction([...BOOK_DATA_STORES], 'readwrite');
    const purgeDone = transactionDone(purgeTx);
    deleteBookDataInTransaction(purgeTx, bookId);
    await purgeDone;

    expect(await listSpeakerSequenceDecisions(contentRevisionId, chapterId)).toEqual([]);
    expect(await listSpeakerArtifactDependencies(contentRevisionId)).toEqual([]);
    expect(await listSpeakerIdentityEdges(bookId)).toEqual([]);
    expect(await listSpeakerVoiceIdentities(bookId)).toEqual([]);
    expect(await listAcceptedSpeakerProvenance({ bookId, contentRevisionId })).toEqual([]);
  });
});
