import 'fake-indexeddb/auto';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { beforeEach, describe, expect, it } from 'vitest';
import { integrityHash } from '../../domain/id-hash-contract';
import { labeledSegmentId } from '../../domain/identity/ai-identities';
import type { LabeledSegment, Paragraph, ParsedNovel } from '../../domain/types';
import { createAcceptedSpeakerProvenance } from '../../providers/speaker-attribution/accepted-speaker-provenance';
import { createSpeakerSequenceDecisionRecord } from '../../providers/speaker-attribution/workflow-state';
import { getSegments, openReaderDb, resetReaderDbForTests, saveImportedNovel } from '../db';
import {
  listAcceptedSpeakerProvenance,
  listSpeakerArtifactDependencies,
  listSpeakerSequenceDecisions,
  replaceAcceptedSpeakerProvenanceForParagraphs,
} from '../speaker-workflow-store';
import { getNativeAnalysisPromotionSnapshot, nativeAnalysisOutputHash } from './fingerprints';
import { promoteNativeAnalysisOutput, promoteNativeAnalysisReview } from './promotion';
import {
  saveNativeAnalysisReviewDraft,
  saveNativeAnalysisWorkflowFence,
  stageNativeAnalysisOutput,
} from './staging-store';
import type { NativeLabelWindowArtifactPayload, NativeSpeakerWorkflowArtifactPayloadV1 } from './types';

const BOOK_ID = 'native-speaker-promotion-book';
const CHAPTER_ID = `${BOOK_ID}:chapter:1`;
const PARAGRAPH_IDS = [`${BOOK_ID}:paragraph:1`, `${BOOK_ID}:paragraph:2`] as const;
const PARAGRAPH_TEXTS = ['Alpha voice.', 'Bravo voice.'] as const;
const CREATED_AT = '2026-07-13T00:00:00.000Z';

function fixture(): ParsedNovel {
  const paragraphs: Paragraph[] = PARAGRAPH_IDS.map((id, index) => ({
    id,
    novelId: BOOK_ID,
    chapterId: CHAPTER_ID,
    index: index + 1,
    text: PARAGRAPH_TEXTS[index]!,
    textHash: integrityHash(PARAGRAPH_TEXTS[index]!),
    startOffsetInChapter: index * 20,
    endOffsetInChapter: index * 20 + PARAGRAPH_TEXTS[index]!.length,
  }));
  const normalizedText = PARAGRAPH_TEXTS.join('\n');
  return {
    novel: {
      id: BOOK_ID,
      title: 'Native speaker promotion',
      sourceFileName: 'speaker.txt',
      sourceEncoding: 'utf-8',
      rawText: normalizedText,
      normalizedText,
      rawTextHash: integrityHash(normalizedText),
      normalizedTextHash: integrityHash(normalizedText),
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      totalChapters: 1,
      totalCharacters: normalizedText.length,
      totalParagraphs: paragraphs.length,
      coverSeed: 1,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    },
    chapters: [
      {
        id: CHAPTER_ID,
        novelId: BOOK_ID,
        index: 1,
        title: 'Chapter 1',
        normalizedText,
        textHash: integrityHash(normalizedText),
        rawStartOffset: 0,
        rawEndOffset: normalizedText.length,
        characterCount: normalizedText.length,
        paragraphCount: paragraphs.length,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ],
    paragraphs,
  };
}

function segment(
  paragraphIndex: number,
  startOffset: number,
  endOffset: number,
  overrides: Partial<LabeledSegment> = {},
): LabeledSegment {
  const paragraphId = PARAGRAPH_IDS[paragraphIndex]!;
  const text = PARAGRAPH_TEXTS[paragraphIndex]!.slice(startOffset, endOffset);
  const segmentTextHash = integrityHash(text);
  return {
    id: labeledSegmentId({
      novelId: BOOK_ID,
      chapterId: CHAPTER_ID,
      paragraphId,
      startOffset,
      endOffset,
      segmentTextHash,
    }),
    novelId: BOOK_ID,
    chapterId: CHAPTER_ID,
    paragraphId,
    segmentIndex: paragraphIndex,
    startOffset,
    endOffset,
    segmentTextHash,
    type: 'narration',
    speakerId: 'character-original',
    candidateSpeakers: [],
    listenerIds: [],
    emotion: 'neutral',
    confidence: 0.9,
    isUserCorrected: false,
    ...overrides,
  };
}

function compactWorkflow(
  contentRevisionId: string,
  jobId: string,
  segments: readonly LabeledSegment[],
): NativeSpeakerWorkflowArtifactPayloadV1 {
  const decisionId = `decision:${jobId}`;
  return {
    version: 'native-speaker-workflow-artifact-v1',
    sequenceRecords: [
      createSpeakerSequenceDecisionRecord({
        bookId: BOOK_ID,
        contentRevisionId,
        chapterId: CHAPTER_ID,
        sceneId: 'scene:1',
        packetFingerprint: `packet:${jobId}`,
        decision: {
          version: 'dialogue-sequence-decision-v1',
          id: decisionId,
          burstOrdinal: 0,
          spanIndexes: segments.map((_, index) => index),
          candidateOrdinals: segments.map(() => [0]),
          selectedSpeakerOrdinals: segments.map(() => 0),
          ruleConstraintBits: segments.map(() => 0),
          decoderMethod: 'min_cost_path',
          disagreementIndexes: [],
          reviewCodes: [],
          fingerprint: `fingerprint:${decisionId}`,
        },
      }),
    ],
    speakerProvenanceDrafts: segments.map((item, index) => ({
      bookId: BOOK_ID,
      contentRevisionId,
      chapterId: CHAPTER_ID,
      paragraphId: item.paragraphId,
      segmentId: item.id,
      sourceSpanId: `span:${jobId}:${index}`,
      sceneId: 'scene:1',
      narrativeOrder: index,
      speakerEntityId: `entity:${item.speakerId}`,
      canonicalSpeakerId: item.speakerId,
      resolutionKind: 'provider_candidate',
      sourceManifestFingerprint: 'manifest:1',
      packetFingerprint: `packet:${jobId}`,
      sequenceDecisionId: decisionId,
      confidence: item.confidence,
    })),
    artifactDependencyIds: ['manifest:1', `packet:${jobId}`, decisionId],
    speakerEntityIdByCanonicalSpeakerId: {
      'character-original': 'entity:character-original',
      'character-reviewed': 'entity:character-reviewed',
    },
    metadata: {
      version: 'native-speaker-batch-metadata-v1',
      jobId,
      packetFingerprints: [`packet:${jobId}`],
      requestHashes: [`request:${jobId}`],
      outputHashes: [`output:${jobId}`],
      sequenceDecisionIds: [decisionId],
      riskRoutes: [],
      routedSpanCount: 0,
      pendingSpeakerEntityCount: 0,
      speakerProvenanceCount: segments.length,
      speakerProvenanceFingerprint: `provenance:${jobId}`,
      providerExecutions: [],
    },
  };
}

async function stageLabel(input: {
  workflowId: string;
  segments: readonly LabeledSegment[];
  plannedParagraphIds: readonly string[];
  compact?: boolean;
  includeResult?: boolean;
}) {
  const jobId = `job:${input.workflowId}`;
  const snapshot = await getNativeAnalysisPromotionSnapshot(BOOK_ID, CHAPTER_ID);
  await saveNativeAnalysisWorkflowFence({
    workflowId: input.workflowId,
    novelId: BOOK_ID,
    contentRevisionId: snapshot.activeContentRevisionId,
    planHash: `plan:${input.workflowId}`,
    fence: 1,
    jobs: [
      { jobId, artifactType: 'label_window', chapterId: CHAPTER_ID, plannedParagraphIds: input.plannedParagraphIds },
    ],
  });
  const result = { characters: [], segments: [...input.segments] };
  const payload: NativeLabelWindowArtifactPayload = {
    kind: 'label_window',
    chapterId: CHAPTER_ID,
    segments: input.segments,
    ...(input.includeResult ? { result } : {}),
    ...(input.compact
      ? { speakerWorkflow: compactWorkflow(snapshot.activeContentRevisionId, jobId, input.segments) }
      : {}),
  };
  const artifact = await stageNativeAnalysisOutput({
    workflowId: input.workflowId,
    jobId,
    novelId: BOOK_ID,
    chapterId: CHAPTER_ID,
    artifactType: 'label_window',
    workflowFence: 1,
    planHash: `plan:${input.workflowId}`,
    expectedContentRevisionId: snapshot.activeContentRevisionId,
    expectedGraphFingerprint: snapshot.graphFingerprint,
    correctionFingerprint: snapshot.correctionFingerprint,
    plannedParagraphIds: input.plannedParagraphIds,
    outputHash: nativeAnalysisOutputHash(payload),
    payload,
  });
  return { artifact, payload, snapshot };
}

async function putSegment(row: LabeledSegment): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction('segments', 'readwrite');
  tx.objectStore('segments').put(row);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function seedAccepted(contentRevisionId: string, row: LabeledSegment): Promise<void> {
  await replaceAcceptedSpeakerProvenanceForParagraphs({
    bookId: BOOK_ID,
    contentRevisionId,
    chapterId: CHAPTER_ID,
    paragraphIds: [row.paragraphId],
    rows: [
      createAcceptedSpeakerProvenance(
        {
          bookId: BOOK_ID,
          contentRevisionId,
          chapterId: CHAPTER_ID,
          paragraphId: row.paragraphId,
          segmentId: row.id,
          sourceSpanId: 'span:old',
          sceneId: 'scene:old',
          narrativeOrder: 0,
          speakerEntityId: 'entity:old',
          canonicalSpeakerId: row.speakerId,
          resolutionKind: 'provider_candidate',
          sourceManifestFingerprint: 'manifest:old',
          confidence: row.confidence,
        },
        'artifact:old',
        CREATED_AT,
      ),
    ],
  });
}

describe('native compact speaker promotion persistence', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
    await saveImportedNovel(fixture());
  });

  it('atomically promotes compact sequence, dependency, and accepted provenance rows', async () => {
    const generated = segment(0, 0, 5);
    const staged = await stageLabel({
      workflowId: 'automatic',
      segments: [generated],
      plannedParagraphIds: [generated.paragraphId],
      compact: true,
    });

    expect((await promoteNativeAnalysisOutput(staged.artifact.id)).status).toBe('promoted');
    expect(await listSpeakerSequenceDecisions(staged.snapshot.activeContentRevisionId, CHAPTER_ID)).toHaveLength(1);
    expect(await listSpeakerArtifactDependencies(staged.snapshot.activeContentRevisionId)).toEqual([
      expect.objectContaining({ artifactId: staged.artifact.id, artifactKind: 'speaker_labels', level: 'L3_speaker' }),
    ]);
    expect(
      await listAcceptedSpeakerProvenance({
        bookId: BOOK_ID,
        contentRevisionId: staged.snapshot.activeContentRevisionId,
        chapterId: CHAPTER_ID,
        activeOnly: true,
      }),
    ).toEqual([
      expect.objectContaining({
        artifactId: staged.artifact.id,
        segmentId: generated.id,
        speakerEntityId: 'entity:character-original',
      }),
    ]);
  });

  it('filters corrected overlaps and supersedes active provenance when no generated row survives', async () => {
    const generated = segment(0, 0, 10);
    const corrected = segment(0, 2, 7, { speakerId: 'character-user', isUserCorrected: true });
    await putSegment(corrected);
    const staged = await stageLabel({
      workflowId: 'overlap',
      segments: [generated],
      plannedParagraphIds: [generated.paragraphId],
      compact: true,
    });
    await seedAccepted(staged.snapshot.activeContentRevisionId, generated);

    expect((await promoteNativeAnalysisOutput(staged.artifact.id)).status).toBe('promoted');
    expect((await getSegments(CHAPTER_ID)).map((item) => item.id)).toEqual([corrected.id]);
    const rows = await listAcceptedSpeakerProvenance({
      bookId: BOOK_ID,
      contentRevisionId: staged.snapshot.activeContentRevisionId,
      chapterId: CHAPTER_ID,
    });
    expect(rows).toEqual([expect.objectContaining({ artifactId: 'artifact:old', status: 'superseded' })]);
  });

  it('reconciles manual speaker edits while preserving original entities for other edits', async () => {
    const first = segment(0, 0, 5);
    const second = segment(1, 0, 5);
    const staged = await stageLabel({
      workflowId: 'review',
      segments: [first, second],
      plannedParagraphIds: [first.paragraphId, second.paragraphId],
      compact: true,
      includeResult: true,
    });
    const candidate = {
      characters: [],
      segments: [
        { ...first, speakerId: 'character-reviewed', isUserCorrected: true },
        { ...second, emotion: 'angry' as const, isUserCorrected: true },
      ],
    };
    const editIntents = {
      [first.id]: { kind: 'segment_only' as const },
      [second.id]: { kind: 'segment_only' as const },
    };
    await saveNativeAnalysisReviewDraft({
      artifactId: staged.artifact.id,
      expectedReviewRevision: 1,
      candidate,
      editIntents,
    });

    await promoteNativeAnalysisReview({
      kind: 'native_review_promotion_v1',
      operationId: 'review:operation',
      artifactId: staged.artifact.id,
      expectedReviewRevision: 2,
      candidateHash: structuredIntegrityHash(candidate),
      editIntentsHash: structuredIntegrityHash(editIntents),
      approvedAt: '2026-07-13T01:00:00.000Z',
    });

    const active = await listAcceptedSpeakerProvenance({
      bookId: BOOK_ID,
      contentRevisionId: staged.snapshot.activeContentRevisionId,
      chapterId: CHAPTER_ID,
      activeOnly: true,
    });
    expect(active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          segmentId: first.id,
          canonicalSpeakerId: 'character-reviewed',
          speakerEntityId: 'entity:character-reviewed',
          resolutionKind: 'manual_review',
        }),
        expect.objectContaining({
          segmentId: second.id,
          canonicalSpeakerId: 'character-original',
          speakerEntityId: 'entity:character-original',
          resolutionKind: 'manual_review',
        }),
      ]),
    );
  });

  it('keeps legacy label promotion compatible while clearing stale active provenance', async () => {
    const generated = segment(0, 0, 5);
    const staged = await stageLabel({
      workflowId: 'legacy',
      segments: [generated],
      plannedParagraphIds: [generated.paragraphId],
    });
    await seedAccepted(staged.snapshot.activeContentRevisionId, generated);

    expect((await promoteNativeAnalysisOutput(staged.artifact.id)).status).toBe('promoted');
    expect(
      await listAcceptedSpeakerProvenance({
        bookId: BOOK_ID,
        contentRevisionId: staged.snapshot.activeContentRevisionId,
        chapterId: CHAPTER_ID,
        activeOnly: true,
      }),
    ).toEqual([]);
    expect(await listSpeakerArtifactDependencies(staged.snapshot.activeContentRevisionId)).toEqual([]);
  });
});
