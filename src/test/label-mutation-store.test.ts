import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LabeledSegment, Novel } from '../domain/types';
import { integrityHash } from '../domain/id-hash-contract';
import {
  chapterSegmentsRevision,
  correctionsRevision,
  ResourceRevisionConflictError,
} from '../domain/resource-revisions';
import { labelMutationSegmentHash, LabelMutationConflictError } from '../providers/label-mutation-contract';
import { createSpeakerArtifactDependency } from '../providers/speaker-attribution/artifact-dependency';
import { getCorrections, getSegments, listSyncOutbox, resetReaderDbForTests } from '../storage/db';
import { transactionDone } from '../storage/indexeddb-transaction';
import { applyLocalLabelCorrections } from '../storage/label-mutation-store';
import { openReaderDb } from '../storage/reader-database';
import { listSpeakerArtifactDependencies, putSpeakerArtifactDependencies } from '../storage/speaker-workflow-store';
import { LocalOutboxSyncService, type SyncEventSource } from '../sync/local-outbox-sync-service';
import type { SyncEvent } from '../sync/types';

const segment: LabeledSegment = {
  id: 'segment_1',
  novelId: 'book_1',
  chapterId: 'chapter_1',
  paragraphId: 'paragraph_1',
  segmentIndex: 0,
  startOffset: 0,
  endOffset: 5,
  segmentTextHash: integrityHash('segment text'),
  type: 'quoted_dialogue',
  speakerId: 'unknown',
  candidateSpeakers: ['character_1'],
  listenerIds: [],
  emotion: 'neutral',
  confidence: 0.5,
  isUserCorrected: false,
};

const novel: Novel = {
  id: 'book_1',
  activeContentRevisionId: 'content_1',
  title: 'Book',
  sourceFileName: 'book.txt',
  rawText: '',
  normalizedText: '',
  rawTextHash: integrityHash('raw'),
  normalizedTextHash: integrityHash('normalized'),
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
  totalChapters: 1,
  totalCharacters: 5,
  totalParagraphs: 1,
  coverSeed: 1,
  lastReadOffset: 0,
  lastReadProgress: 0,
  favorite: false,
  analysisStatus: 'needs_review',
};

function command(operationId = 'operation_1') {
  return {
    operationId,
    bookId: novel.id,
    chapterId: segment.chapterId,
    createdAt: '2026-07-11T01:00:00.000Z',
    expected: {
      contentRevisionId: 'content_1',
      correctionRevisionId: correctionsRevision([]),
      segmentCollectionRevision: chapterSegmentsRevision([segment]),
    },
    edits: [
      {
        segmentId: segment.id,
        expectedSegmentHash: labelMutationSegmentHash(segment),
        patch: { speakerId: 'character_1', emotion: 'tense' },
        intent: { kind: 'segment_only' as const },
      },
    ],
  };
}

describe('local label mutation store', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
    const db = await openReaderDb();
    const tx = db.transaction(['novels', 'segments'], 'readwrite');
    tx.objectStore('novels').put(novel);
    tx.objectStore('segments').put(segment);
    await transactionDone(tx);
  });

  it('commits segments, correction provenance, invalidation receipt, and outbox atomically', async () => {
    const result = await applyLocalLabelCorrections(command());

    expect(await getSegments(segment.chapterId)).toEqual([
      expect.objectContaining({ speakerId: 'character_1', emotion: 'tense', isUserCorrected: true }),
    ]);
    expect((await getCorrections(novel.id)).map((item) => item.correctionType).sort()).toEqual(['emotion', 'speaker']);
    expect(result.createdCorrectionIds).toHaveLength(2);
    expect(result.invalidation.staleTTSRenderItemIds).toEqual([segment.id]);
    const outbox = await listSyncOutbox();
    expect(outbox.map((item) => item.event.type).sort()).toEqual([
      'chapter_segments_updated',
      'user_correction_created',
      'user_correction_created',
    ]);
    expect(
      outbox.every(
        (item) => (item.event.payload as Record<string, unknown>).compoundOperationId === command().operationId,
      ),
    ).toBe(true);
  });

  it('replays the stored receipt without duplicate writes', async () => {
    const first = await applyLocalLabelCorrections(command());
    const outboxCount = (await listSyncOutbox()).length;
    const replay = await applyLocalLabelCorrections(command());

    expect(replay).toEqual(first);
    expect(await listSyncOutbox()).toHaveLength(outboxCount);
  });

  it('pushes every compound event together without segment compaction', async () => {
    await applyLocalLabelCorrections(command());
    const pushed: SyncEvent[] = [];
    const source: SyncEventSource = {
      async pushSync(events) {
        pushed.push(...events);
        return { accepted: events.length, acceptedIds: events.map((event) => event.id) };
      },
      async pullSync() {
        return { cursor: 0, events: [] };
      },
    };

    await new LocalOutboxSyncService(source).flushPending();

    expect(pushed.map((event) => event.type)).toEqual([
      'chapter_segments_updated',
      'user_correction_created',
      'user_correction_created',
    ]);
    expect(
      pushed.every((event) => (event.payload as Record<string, unknown>).compoundOperationId === command().operationId),
    ).toBe(true);
  });

  it('rejects operation reuse and stale aggregate fences without partial writes', async () => {
    await applyLocalLabelCorrections(command());
    await expect(
      applyLocalLabelCorrections({
        ...command(),
        edits: [{ ...command().edits[0], patch: { speakerId: 'character_2' } }],
      }),
    ).rejects.toBeInstanceOf(LabelMutationConflictError);

    const before = await getSegments(segment.chapterId);
    await expect(
      applyLocalLabelCorrections({
        ...command('operation_2'),
        expected: { ...command().expected, segmentCollectionRevision: 'stale' },
      }),
    ).rejects.toBeInstanceOf(ResourceRevisionConflictError);
    expect(await getSegments(segment.chapterId)).toEqual(before);
  });

  it('invalidates speaker and voice lineage for speaker edits in the same transaction', async () => {
    const speakerDependency = createSpeakerArtifactDependency({
      bookId: novel.id,
      contentRevisionId: 'content_1',
      chapterId: segment.chapterId,
      artifactId: 'speaker_artifact',
      artifactKind: 'speaker_labels',
      level: 'L3_speaker',
      dependencyIds: ['source_inventory'],
    });
    const voiceDependency = createSpeakerArtifactDependency({
      bookId: novel.id,
      contentRevisionId: 'content_1',
      chapterId: segment.chapterId,
      artifactId: 'voice_artifact',
      artifactKind: 'voice_assignment',
      level: 'L4_voice',
      dependencyIds: [speakerDependency.artifactId],
    });
    await putSpeakerArtifactDependencies([speakerDependency, voiceDependency]);

    await applyLocalLabelCorrections(command());

    expect(
      (await listSpeakerArtifactDependencies('content_1'))
        .map(({ level, status, staleReason }) => ({ level, status, staleReason }))
        .sort((left, right) => left.level.localeCompare(right.level)),
    ).toEqual([
      { level: 'L3_speaker', status: 'stale', staleReason: 'label_mutation:operation_1' },
      { level: 'L4_voice', status: 'stale', staleReason: 'label_mutation:operation_1' },
    ]);
  });

  it('keeps speaker lineage active when only emotion delivery changes', async () => {
    const dependencies = (['L3_speaker', 'L4_voice'] as const).map((level) =>
      createSpeakerArtifactDependency({
        bookId: novel.id,
        contentRevisionId: 'content_1',
        chapterId: segment.chapterId,
        artifactId: `${level}_artifact`,
        artifactKind: level === 'L3_speaker' ? 'speaker_labels' : 'voice_assignment',
        level,
        dependencyIds: ['source_inventory'],
      }),
    );
    await putSpeakerArtifactDependencies(dependencies);
    const emotionOnly = command('operation_emotion');

    await applyLocalLabelCorrections({
      ...emotionOnly,
      edits: [
        {
          ...emotionOnly.edits[0],
          patch: { emotion: 'tense' },
        },
      ],
    });

    expect(
      (await listSpeakerArtifactDependencies('content_1'))
        .map(({ level, status }) => ({ level, status }))
        .sort((left, right) => left.level.localeCompare(right.level)),
    ).toEqual([
      { level: 'L3_speaker', status: 'active' },
      { level: 'L4_voice', status: 'stale' },
    ]);
  });
});
