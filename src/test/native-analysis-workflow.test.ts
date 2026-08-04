import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { integrityHash } from '../domain/id-hash-contract';
import { labeledSegmentId } from '../domain/identity/ai-identities';
import type { Character, LabeledSegment, Paragraph, ParsedNovel, UserCorrection } from '../domain/types';
import type { CharacterGraph } from '../providers/ai';
import {
  applyRemoteSyncEvents,
  getCharacters,
  getCorrections,
  getSegments,
  listSyncOutbox,
  openReaderDb,
  resetReaderDbForTests,
  saveCorrection,
  saveImportedNovel,
} from '../storage/db';
import {
  getNativeAnalysisPromotionSnapshot,
  listNativeAnalysisStagedOutputs,
  listNativeAnalysisProvenance,
  nativeAnalysisOutputHash,
  promoteNativeAnalysisOutput,
  promoteNativeAnalysisReview,
  saveNativeAnalysisReviewDraft,
  saveNativeAnalysisWorkflowFence,
  stageNativeAnalysisOutput,
  type NativeAnalysisArtifactPayload,
  type NativeAnalysisStagedOutput,
  type NativeAnalysisWorkflowJobPlan,
  type StageNativeAnalysisOutputInput,
} from '../storage/native-analysis-workflow';

const NOVEL_ID = 'native-analysis-book';
const CHAPTER_ID = `${NOVEL_ID}:chapter:1`;
const PARAGRAPH_IDS = [1, 2, 3].map((index) => `${NOVEL_ID}:paragraph:${index}`);
const PARAGRAPH_TEXT = new Map([
  [PARAGRAPH_IDS[0]!, 'Alpha voice.'],
  [PARAGRAPH_IDS[1]!, 'Bravo delta.'],
  [PARAGRAPH_IDS[2]!, 'Charlie echo.'],
]);

function fixture(suffix = 'one'): ParsedNovel {
  const createdAt = '2026-07-11T00:00:00.000Z';
  const paragraphs: Paragraph[] = PARAGRAPH_IDS.map((id, offset) => {
    const text = PARAGRAPH_TEXT.get(id)!;
    return {
      id,
      novelId: NOVEL_ID,
      chapterId: CHAPTER_ID,
      index: offset + 1,
      text,
      startOffsetInChapter: offset * 20,
      endOffsetInChapter: offset * 20 + text.length,
      textHash: integrityHash(text),
    };
  });
  const normalizedText = paragraphs.map((paragraph) => paragraph.text).join('\n');
  return {
    novel: {
      id: NOVEL_ID,
      title: `Native fixture ${suffix}`,
      sourceFileName: `${suffix}.txt`,
      sourceEncoding: 'utf-8',
      rawText: normalizedText,
      normalizedText,
      rawTextHash: integrityHash(`${suffix}:${normalizedText}`),
      normalizedTextHash: integrityHash(normalizedText),
      createdAt,
      updatedAt: createdAt,
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
        novelId: NOVEL_ID,
        index: 1,
        title: 'Chapter 1',
        normalizedText,
        textHash: integrityHash(normalizedText),
        rawStartOffset: 0,
        rawEndOffset: normalizedText.length,
        characterCount: normalizedText.length,
        paragraphCount: paragraphs.length,
        createdAt,
        updatedAt: createdAt,
      },
    ],
    paragraphs,
  };
}

function segment(
  paragraphId: string,
  startOffset: number,
  endOffset: number,
  overrides: Partial<LabeledSegment> = {},
): LabeledSegment {
  const text = PARAGRAPH_TEXT.get(paragraphId)!.slice(startOffset, endOffset);
  const segmentTextHash = integrityHash(text);
  return {
    id: labeledSegmentId({
      novelId: NOVEL_ID,
      chapterId: CHAPTER_ID,
      paragraphId,
      startOffset,
      endOffset,
      segmentTextHash,
    }),
    novelId: NOVEL_ID,
    chapterId: CHAPTER_ID,
    paragraphId,
    segmentIndex: 0,
    startOffset,
    endOffset,
    segmentTextHash,
    type: 'narration',
    speakerId: 'narrator',
    candidateSpeakers: [],
    listenerIds: [],
    emotion: 'neutral',
    confidence: 0.8,
    isUserCorrected: false,
    ...overrides,
  };
}

async function putRows(storeName: 'characters' | 'segments', rows: readonly (Character | LabeledSegment)[]) {
  const db = await openReaderDb();
  const tx = db.transaction(storeName, 'readwrite');
  for (const row of rows) tx.objectStore(storeName).put(row);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function registerWorkflow(workflowId: string, jobs: readonly NativeAnalysisWorkflowJobPlan[], fence = 1) {
  const snapshot = await getNativeAnalysisPromotionSnapshot(NOVEL_ID, jobs[0]?.chapterId);
  await saveNativeAnalysisWorkflowFence({
    workflowId,
    novelId: NOVEL_ID,
    contentRevisionId: snapshot.activeContentRevisionId,
    planHash: `plan:${workflowId}`,
    fence,
    jobs,
  });
  return snapshot;
}

async function stage(
  workflowId: string,
  job: NativeAnalysisWorkflowJobPlan,
  payload: NativeAnalysisArtifactPayload,
  snapshot: Awaited<ReturnType<typeof getNativeAnalysisPromotionSnapshot>>,
  workflowFence = 1,
): Promise<{ artifact: NativeAnalysisStagedOutput; input: StageNativeAnalysisOutputInput }> {
  const common = {
    workflowId,
    jobId: job.jobId,
    novelId: NOVEL_ID,
    workflowFence,
    planHash: `plan:${workflowId}`,
    expectedContentRevisionId: snapshot.activeContentRevisionId,
    expectedGraphFingerprint: snapshot.graphFingerprint,
    correctionFingerprint: snapshot.correctionFingerprint,
    plannedParagraphIds: job.plannedParagraphIds,
    outputHash: nativeAnalysisOutputHash(payload),
  };
  const input = (
    job.artifactType === 'character_graph'
      ? { ...common, artifactType: 'character_graph', payload }
      : { ...common, artifactType: 'label_window', chapterId: job.chapterId!, payload }
  ) as StageNativeAnalysisOutputInput;
  return { artifact: await stageNativeAnalysisOutput(input), input };
}

function aiEvents(type: 'character_graph_updated' | 'chapter_segments_updated') {
  return listSyncOutbox().then((items) => items.filter((item) => item.event.type === type));
}

describe('native analysis IndexedDB promotion boundary', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
    await saveImportedNovel(fixture());
  });

  it('stages graph checkpoints idempotently, preserves confirmed fields, and replays promotion exactly once', async () => {
    const confirmed: Character = {
      id: 'character-confirmed',
      novelId: NOVEL_ID,
      canonicalName: 'User Name',
      aliases: ['User Alias'],
      color: '#123456',
      description: 'User description',
      confidence: 0.95,
      isUserConfirmed: true,
    };
    const confirmedOnly = { ...confirmed, id: 'character-confirmed-only', canonicalName: 'Confirmed Only' };
    await putRows('characters', [confirmed, confirmedOnly]);
    const job: NativeAnalysisWorkflowJobPlan = {
      jobId: 'graph-job',
      artifactType: 'character_graph',
      plannedParagraphIds: [],
    };
    const snapshot = await registerWorkflow('graph-workflow', [job]);
    const graph: CharacterGraph = {
      novelId: NOVEL_ID,
      characters: [
        { ...confirmed, canonicalName: 'Model Name', aliases: ['Model Alias'], isUserConfirmed: false },
        {
          id: 'character-generated',
          novelId: NOVEL_ID,
          canonicalName: 'Generated',
          aliases: [],
          color: '#abcdef',
          confidence: 0.7,
          isUserConfirmed: false,
        },
      ],
      relations: [],
    };
    const staged = await stage('graph-workflow', job, { kind: 'character_graph', graph }, snapshot);
    expect((await stageNativeAnalysisOutput(staged.input)).id).toBe(staged.artifact.id);

    expect((await promoteNativeAnalysisOutput(staged.artifact.id)).status).toBe('promoted');
    expect((await promoteNativeAnalysisOutput(staged.artifact.id)).status).toBe('already_promoted');
    expect((await stageNativeAnalysisOutput(staged.input)).status).toBe('promoted');

    const characters = await getCharacters(NOVEL_ID);
    expect(characters.find((item) => item.id === confirmed.id)).toEqual(confirmed);
    expect(characters.find((item) => item.id === confirmedOnly.id)).toEqual(confirmedOnly);
    expect(characters.some((item) => item.id === 'character-generated')).toBe(true);
    expect(await aiEvents('character_graph_updated')).toHaveLength(1);
    expect(await listNativeAnalysisProvenance(NOVEL_ID)).toHaveLength(1);
  });

  it('replaces only generated rows in each label window and deterministically renumbers the chapter', async () => {
    const oldPlanned = segment(PARAGRAPH_IDS[1]!, 0, 4, { segmentIndex: 1, speakerId: 'unknown' });
    const corrected = segment(PARAGRAPH_IDS[1]!, 6, 11, {
      segmentIndex: 2,
      speakerId: 'character-user',
      emotion: 'angry',
      isUserCorrected: true,
    });
    const firstSibling = segment(PARAGRAPH_IDS[0]!, 0, 5, { segmentIndex: 0 });
    const lastSibling = segment(PARAGRAPH_IDS[2]!, 0, 7, { segmentIndex: 3, speakerId: 'character-old' });
    await putRows('segments', [oldPlanned, corrected, firstSibling, lastSibling]);

    const firstJob: NativeAnalysisWorkflowJobPlan = {
      jobId: 'label-job-1',
      artifactType: 'label_window',
      chapterId: CHAPTER_ID,
      plannedParagraphIds: [PARAGRAPH_IDS[1]!],
    };
    const secondJob: NativeAnalysisWorkflowJobPlan = {
      jobId: 'label-job-2',
      artifactType: 'label_window',
      chapterId: CHAPTER_ID,
      plannedParagraphIds: [PARAGRAPH_IDS[2]!],
    };
    const snapshot = await registerWorkflow('label-workflow', [firstJob, secondJob]);
    const generated = segment(PARAGRAPH_IDS[1]!, 0, 5, { speakerId: 'character-model' });
    const correctedCollision = { ...corrected, speakerId: 'character-model', isUserCorrected: false };
    const first = await stage(
      'label-workflow',
      firstJob,
      { kind: 'label_window', chapterId: CHAPTER_ID, segments: [generated, correctedCollision] },
      snapshot,
    );
    expect((await promoteNativeAnalysisOutput(first.artifact.id)).status).toBe('promoted');

    let segments = await getSegments(CHAPTER_ID);
    expect(segments.map((item) => item.id)).toEqual([firstSibling.id, generated.id, corrected.id, lastSibling.id]);
    expect(segments.map((item) => item.segmentIndex)).toEqual([0, 1, 2, 3]);
    expect(segments.find((item) => item.id === corrected.id)).toEqual({ ...corrected, segmentIndex: 2 });

    const secondSnapshot = await getNativeAnalysisPromotionSnapshot(NOVEL_ID, CHAPTER_ID);
    const replacementLast = segment(PARAGRAPH_IDS[2]!, 0, 8, { speakerId: 'character-new' });
    const second = await stage(
      'label-workflow',
      secondJob,
      { kind: 'label_window', chapterId: CHAPTER_ID, segments: [replacementLast] },
      secondSnapshot,
    );
    expect((await promoteNativeAnalysisOutput(second.artifact.id)).status).toBe('promoted');
    segments = await getSegments(CHAPTER_ID);
    expect(segments.map((item) => item.id)).toEqual([firstSibling.id, generated.id, corrected.id, replacementLast.id]);
    expect(segments.map((item) => item.segmentIndex)).toEqual([0, 1, 2, 3]);
    expect(await aiEvents('chapter_segments_updated')).toHaveLength(2);
    expect(await listNativeAnalysisProvenance(NOVEL_ID)).toHaveLength(2);
  });

  it('keeps the generated label candidate immutable while saving a revisioned review draft', async () => {
    const job: NativeAnalysisWorkflowJobPlan = {
      jobId: 'review-label-job',
      artifactType: 'label_window',
      chapterId: CHAPTER_ID,
      plannedParagraphIds: [PARAGRAPH_IDS[1]!],
    };
    const snapshot = await registerWorkflow('review-label-workflow', [job]);
    const generated = segment(PARAGRAPH_IDS[1]!, 0, 5, { speakerId: 'unknown' });
    const originalCandidate = {
      chapterId: CHAPTER_ID,
      characters: [],
      segments: [generated],
    };
    const staged = await stage(
      'review-label-workflow',
      job,
      {
        kind: 'label_window',
        chapterId: CHAPTER_ID,
        segments: originalCandidate.segments,
        result: originalCandidate,
      },
      snapshot,
    );
    const reviewedCandidate = {
      ...originalCandidate,
      segments: [{ ...generated, speakerId: 'character-reviewed', confidence: 1 }],
    };

    const saved = await saveNativeAnalysisReviewDraft({
      artifactId: staged.artifact.id,
      expectedReviewRevision: 1,
      candidate: reviewedCandidate,
      editIntents: { [generated.id]: { kind: 'segment_only' } },
    });

    expect(saved).toMatchObject({ reviewRevision: 2, reviewStatus: 'editing', reviewDraft: reviewedCandidate });
    expect(saved.payload).toEqual(staged.artifact.payload);
    expect(await listNativeAnalysisStagedOutputs('review-label-workflow')).toEqual([saved]);
    await expect(
      saveNativeAnalysisReviewDraft({
        artifactId: staged.artifact.id,
        expectedReviewRevision: 1,
        candidate: reviewedCandidate,
        editIntents: {},
      }),
    ).rejects.toThrow('changed before the draft was saved');
  });

  it('atomically promotes an approved native review with correction provenance and a replayable receipt', async () => {
    const job: NativeAnalysisWorkflowJobPlan = {
      jobId: 'approved-review-job',
      artifactType: 'label_window',
      chapterId: CHAPTER_ID,
      plannedParagraphIds: [PARAGRAPH_IDS[1]!],
    };
    const snapshot = await registerWorkflow('approved-review-workflow', [job]);
    const generated = segment(PARAGRAPH_IDS[1]!, 0, PARAGRAPH_TEXT.get(PARAGRAPH_IDS[1]!)!.length, {
      speakerId: 'unknown',
    });
    const originalCandidate = { characters: [], segments: [generated] };
    const staged = await stage(
      'approved-review-workflow',
      job,
      {
        kind: 'label_window',
        chapterId: CHAPTER_ID,
        segments: originalCandidate.segments,
        result: originalCandidate,
      },
      snapshot,
    );
    const approvedCandidate = {
      ...originalCandidate,
      segments: [{ ...generated, speakerId: 'character-reviewed', confidence: 1, isUserCorrected: true }],
    };
    const editIntents = { [generated.id]: { kind: 'segment_only' as const } };
    await saveNativeAnalysisReviewDraft({
      artifactId: staged.artifact.id,
      expectedReviewRevision: 1,
      candidate: approvedCandidate,
      editIntents,
    });
    const command = {
      kind: 'native_review_promotion_v1' as const,
      operationId: 'approved-review-operation',
      artifactId: staged.artifact.id,
      expectedReviewRevision: 2,
      candidateHash: structuredIntegrityHash(approvedCandidate),
      editIntentsHash: structuredIntegrityHash(editIntents),
      approvedAt: '2026-07-11T01:00:00.000Z',
    };

    const result = await promoteNativeAnalysisReview(command);
    const replay = await promoteNativeAnalysisReview(command);

    expect(replay).toEqual(result);
    expect((await getSegments(CHAPTER_ID))[0]).toMatchObject({
      speakerId: 'character-reviewed',
      isUserCorrected: true,
    });
    expect(await getCorrections(NOVEL_ID)).toEqual([
      expect.objectContaining({
        operationId: command.operationId,
        correctionType: 'speaker',
        provenanceKind: 'user_label_mutation',
        sourceReviewArtifactId: staged.artifact.id,
      }),
    ]);
    expect(result.createdCorrectionIds).toHaveLength(1);
    expect(await aiEvents('chapter_segments_updated')).toHaveLength(1);
    expect(await listNativeAnalysisProvenance(NOVEL_ID)).toHaveLength(1);
  });

  it('rejects incomplete or invalid page-backed label anchors before canonical writes', async () => {
    const existing = segment(PARAGRAPH_IDS[1]!, 0, 5, { speakerId: 'character-existing' });
    await putRows('segments', [existing]);

    const cases: Array<{
      workflowId: string;
      plannedParagraphIds: string[];
      segments: LabeledSegment[];
      status: 'stale' | 'rejected';
      reason: string;
    }> = [
      {
        workflowId: 'empty-anchors',
        plannedParagraphIds: [PARAGRAPH_IDS[1]!],
        segments: [],
        status: 'rejected',
        reason: 'generated_segments_empty',
      },
      {
        workflowId: 'missing-planned-paragraph',
        plannedParagraphIds: [`${NOVEL_ID}:paragraph:missing`],
        segments: [],
        status: 'stale',
        reason: 'planned_paragraphs_stale',
      },
      {
        workflowId: 'incomplete-coverage',
        plannedParagraphIds: [PARAGRAPH_IDS[0]!, PARAGRAPH_IDS[1]!],
        segments: [segment(PARAGRAPH_IDS[0]!, 0, 5)],
        status: 'rejected',
        reason: 'generated_segment_coverage_incomplete',
      },
      {
        workflowId: 'out-of-range-anchor',
        plannedParagraphIds: [PARAGRAPH_IDS[1]!],
        segments: [segment(PARAGRAPH_IDS[1]!, 0, 100)],
        status: 'rejected',
        reason: 'generated_segment_offsets_invalid',
      },
      {
        workflowId: 'overlapping-anchors',
        plannedParagraphIds: [PARAGRAPH_IDS[1]!],
        segments: [segment(PARAGRAPH_IDS[1]!, 0, 7), segment(PARAGRAPH_IDS[1]!, 5, 11)],
        status: 'rejected',
        reason: 'generated_segments_overlap',
      },
    ];

    const wrongHash = integrityHash('not the source slice');
    const hashMismatch = segment(PARAGRAPH_IDS[1]!, 0, 5, { segmentTextHash: wrongHash });
    cases.push({
      workflowId: 'hash-mismatch-anchor',
      plannedParagraphIds: [PARAGRAPH_IDS[1]!],
      segments: [
        {
          ...hashMismatch,
          id: labeledSegmentId({
            novelId: hashMismatch.novelId,
            chapterId: hashMismatch.chapterId,
            paragraphId: hashMismatch.paragraphId,
            startOffset: hashMismatch.startOffset,
            endOffset: hashMismatch.endOffset,
            segmentTextHash: hashMismatch.segmentTextHash,
          }),
        },
      ],
      status: 'rejected',
      reason: 'generated_segment_text_hash_mismatch',
    });

    for (const testCase of cases) {
      const job: NativeAnalysisWorkflowJobPlan = {
        jobId: `${testCase.workflowId}-job`,
        artifactType: 'label_window',
        chapterId: CHAPTER_ID,
        plannedParagraphIds: testCase.plannedParagraphIds,
      };
      const snapshot = await registerWorkflow(testCase.workflowId, [job]);
      const staged = await stage(
        testCase.workflowId,
        job,
        { kind: 'label_window', chapterId: CHAPTER_ID, segments: testCase.segments },
        snapshot,
      );
      expect(await promoteNativeAnalysisOutput(staged.artifact.id)).toMatchObject({
        status: testCase.status,
        reason: testCase.reason,
      });
      expect(await getSegments(CHAPTER_ID)).toEqual([existing]);
    }

    expect(await aiEvents('chapter_segments_updated')).toEqual([]);
    expect(await listNativeAnalysisProvenance(NOVEL_ID)).toEqual([]);
  });

  it('syncs a remote-equivalent chapter snapshot when an earlier window shifts later indices', async () => {
    const oldFirst = segment(PARAGRAPH_IDS[0]!, 0, 5, { segmentIndex: 0, speakerId: 'character-old' });
    const later = segment(PARAGRAPH_IDS[1]!, 0, 5, { segmentIndex: 1, speakerId: 'character-later' });
    const corrected = segment(PARAGRAPH_IDS[2]!, 0, 7, {
      segmentIndex: 2,
      speakerId: 'character-user',
      isUserCorrected: true,
    });
    await putRows('segments', [oldFirst, later, corrected]);

    const job: NativeAnalysisWorkflowJobPlan = {
      jobId: 'earlier-window-job',
      artifactType: 'label_window',
      chapterId: CHAPTER_ID,
      plannedParagraphIds: [PARAGRAPH_IDS[0]!],
    };
    const snapshot = await registerWorkflow('earlier-window-workflow', [job]);
    const firstHalf = segment(PARAGRAPH_IDS[0]!, 0, 2, { speakerId: 'character-new' });
    const secondHalf = segment(PARAGRAPH_IDS[0]!, 2, 5, { speakerId: 'character-new' });
    const staged = await stage(
      'earlier-window-workflow',
      job,
      { kind: 'label_window', chapterId: CHAPTER_ID, segments: [firstHalf, secondHalf] },
      snapshot,
    );
    expect((await promoteNativeAnalysisOutput(staged.artifact.id)).status).toBe('promoted');

    const localSegments = await getSegments(CHAPTER_ID);
    expect(localSegments.map((item) => item.id)).toEqual([firstHalf.id, secondHalf.id, later.id, corrected.id]);
    expect(localSegments.map((item) => item.segmentIndex)).toEqual([0, 1, 2, 3]);

    const events = await aiEvents('chapter_segments_updated');
    expect(events).toHaveLength(1);
    expect(events[0]!.event.payload).toEqual({
      mode: 'replace',
      chapterId: CHAPTER_ID,
      segments: localSegments,
    });

    await resetReaderDbForTests();
    await saveImportedNovel(fixture());
    await applyRemoteSyncEvents([events[0]!.event]);
    expect(await getSegments(CHAPTER_ID)).toEqual(localSegments);
    expect((await getSegments(CHAPTER_ID)).find((item) => item.id === corrected.id)?.isUserCorrected).toBe(true);
  });

  it('promotes only one output for the same workflow job fence', async () => {
    const job: NativeAnalysisWorkflowJobPlan = {
      jobId: 'single-output-job',
      artifactType: 'label_window',
      chapterId: CHAPTER_ID,
      plannedParagraphIds: [PARAGRAPH_IDS[1]!],
    };
    const snapshot = await registerWorkflow('single-output-workflow', [job]);
    const firstSegment = segment(PARAGRAPH_IDS[1]!, 0, 5, { speakerId: 'character-first' });
    const first = await stage(
      'single-output-workflow',
      job,
      { kind: 'label_window', chapterId: CHAPTER_ID, segments: [firstSegment] },
      snapshot,
    );
    expect((await promoteNativeAnalysisOutput(first.artifact.id)).status).toBe('promoted');

    const alternateSegment = segment(PARAGRAPH_IDS[1]!, 0, 4, { speakerId: 'character-alternate' });
    const alternate = await stage(
      'single-output-workflow',
      job,
      { kind: 'label_window', chapterId: CHAPTER_ID, segments: [alternateSegment] },
      snapshot,
    );
    expect(await promoteNativeAnalysisOutput(alternate.artifact.id)).toMatchObject({
      status: 'rejected',
      reason: 'job_output_already_promoted',
    });
    expect((await getSegments(CHAPTER_ID)).map((item) => item.id)).toEqual([firstSegment.id]);
    expect(await aiEvents('chapter_segments_updated')).toHaveLength(1);
    expect(await listNativeAnalysisProvenance(NOVEL_ID)).toHaveLength(1);
  });

  it('rejects label rows outside planned paragraphs without touching canonical rows or outbox', async () => {
    const existing = segment(PARAGRAPH_IDS[1]!, 0, 4, { speakerId: 'character-existing' });
    await putRows('segments', [existing]);
    const job: NativeAnalysisWorkflowJobPlan = {
      jobId: 'outside-job',
      artifactType: 'label_window',
      chapterId: CHAPTER_ID,
      plannedParagraphIds: [PARAGRAPH_IDS[1]!],
    };
    const snapshot = await registerWorkflow('outside-workflow', [job]);
    const outside = segment(PARAGRAPH_IDS[2]!, 0, 7);
    const staged = await stage(
      'outside-workflow',
      job,
      { kind: 'label_window', chapterId: CHAPTER_ID, segments: [outside] },
      snapshot,
    );
    const beforeEvents = await aiEvents('chapter_segments_updated');
    const result = await promoteNativeAnalysisOutput(staged.artifact.id);
    expect(result).toMatchObject({ status: 'rejected', reason: 'segment_outside_planned_paragraphs' });
    expect(await getSegments(CHAPTER_ID)).toEqual([existing]);
    expect(await aiEvents('chapter_segments_updated')).toHaveLength(beforeEvents.length);
    expect(await listNativeAnalysisProvenance(NOVEL_ID)).toEqual([]);
  });

  it('rejects mismatched and tampered checkpoint output hashes before canonical writes', async () => {
    const db = await openReaderDb();
    expect(db.objectStoreNames.contains('native_analysis_workflows')).toBe(true);
    expect(db.objectStoreNames.contains('native_analysis_staging')).toBe(true);
    expect(db.objectStoreNames.contains('native_analysis_provenance')).toBe(true);
    const job: NativeAnalysisWorkflowJobPlan = {
      jobId: 'hash-job',
      artifactType: 'character_graph',
      plannedParagraphIds: [],
    };
    const snapshot = await registerWorkflow('hash-workflow', [job]);
    const payload: NativeAnalysisArtifactPayload = {
      kind: 'character_graph',
      graph: { novelId: NOVEL_ID, characters: [], relations: [] },
    };
    const staged = await stage('hash-workflow', job, payload, snapshot);
    await expect(
      stageNativeAnalysisOutput({ ...staged.input, outputHash: integrityHash('incorrect-output') }),
    ).rejects.toThrow('output hash mismatch');

    const tamperedPayload = {
      ...payload,
      graph: {
        ...payload.graph,
        characters: [
          {
            id: 'tampered-character',
            novelId: NOVEL_ID,
            canonicalName: 'Tampered',
            aliases: [],
            color: '#000000',
            confidence: 0.5,
            isUserConfirmed: false,
          },
        ],
      },
    };
    const tx = db.transaction('native_analysis_staging', 'readwrite');
    tx.objectStore('native_analysis_staging').put({ ...staged.artifact, payload: tamperedPayload });
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    expect(await promoteNativeAnalysisOutput(staged.artifact.id)).toMatchObject({
      status: 'rejected',
      reason: 'output_hash_mismatch',
    });
    expect(await getCharacters(NOVEL_ID)).toEqual([]);
    expect(await aiEvents('character_graph_updated')).toHaveLength(0);
  });

  it('leaves canonical graph and outbox unchanged when the active content revision changes', async () => {
    const job: NativeAnalysisWorkflowJobPlan = {
      jobId: 'content-stale-job',
      artifactType: 'character_graph',
      plannedParagraphIds: [],
    };
    const snapshot = await registerWorkflow('content-stale-workflow', [job]);
    const graph: CharacterGraph = {
      novelId: NOVEL_ID,
      characters: [
        {
          id: 'late-character',
          novelId: NOVEL_ID,
          canonicalName: 'Late',
          aliases: [],
          color: '#999999',
          confidence: 0.5,
          isUserConfirmed: false,
        },
      ],
      relations: [],
    };
    const staged = await stage('content-stale-workflow', job, { kind: 'character_graph', graph }, snapshot);
    await saveImportedNovel(fixture('replacement'));
    const beforeEvents = await aiEvents('character_graph_updated');
    expect(await promoteNativeAnalysisOutput(staged.artifact.id)).toMatchObject({
      status: 'stale',
      reason: 'content_revision_stale',
    });
    expect((await getCharacters(NOVEL_ID)).some((item) => item.id === 'late-character')).toBe(false);
    expect(await aiEvents('character_graph_updated')).toHaveLength(beforeEvents.length);
  });

  it('rejects promotion after the workflow fence advances', async () => {
    const job: NativeAnalysisWorkflowJobPlan = {
      jobId: 'fence-job',
      artifactType: 'character_graph',
      plannedParagraphIds: [],
    };
    const snapshot = await registerWorkflow('fence-workflow', [job]);
    const payload: NativeAnalysisArtifactPayload = {
      kind: 'character_graph',
      graph: { novelId: NOVEL_ID, characters: [], relations: [] },
    };
    const staged = await stage('fence-workflow', job, payload, snapshot);
    await saveNativeAnalysisWorkflowFence({
      workflowId: 'fence-workflow',
      novelId: NOVEL_ID,
      contentRevisionId: snapshot.activeContentRevisionId,
      planHash: 'plan:fence-workflow',
      fence: 2,
      jobs: [job],
    });
    expect(await promoteNativeAnalysisOutput(staged.artifact.id)).toMatchObject({
      status: 'stale',
      reason: 'workflow_fence_stale',
    });
    expect(await aiEvents('character_graph_updated')).toHaveLength(0);
  });

  it('restages identical output under a new fence while remaining idempotent within that fence', async () => {
    const job: NativeAnalysisWorkflowJobPlan = {
      jobId: 'fence-retry-job',
      artifactType: 'character_graph',
      plannedParagraphIds: [],
    };
    const snapshot = await registerWorkflow('fence-retry-workflow', [job]);
    const payload: NativeAnalysisArtifactPayload = {
      kind: 'character_graph',
      graph: { novelId: NOVEL_ID, characters: [], relations: [] },
    };
    const stale = await stage('fence-retry-workflow', job, payload, snapshot);
    await saveNativeAnalysisWorkflowFence({
      workflowId: 'fence-retry-workflow',
      novelId: NOVEL_ID,
      contentRevisionId: snapshot.activeContentRevisionId,
      planHash: 'plan:fence-retry-workflow',
      fence: 2,
      jobs: [job],
    });
    expect(await promoteNativeAnalysisOutput(stale.artifact.id)).toMatchObject({
      status: 'stale',
      reason: 'workflow_fence_stale',
    });

    const retry = await stage('fence-retry-workflow', job, payload, snapshot, 2);
    expect(retry.artifact.id).not.toBe(stale.artifact.id);
    expect((await stageNativeAnalysisOutput(retry.input)).id).toBe(retry.artifact.id);
    expect((await promoteNativeAnalysisOutput(retry.artifact.id)).status).toBe('promoted');
    expect((await promoteNativeAnalysisOutput(retry.artifact.id)).status).toBe('already_promoted');
    expect(await aiEvents('character_graph_updated')).toHaveLength(1);
  });

  it('uses refreshed fingerprint inputs in artifact identity for same-fence retries', async () => {
    const job: NativeAnalysisWorkflowJobPlan = {
      jobId: 'fingerprint-retry-job',
      artifactType: 'label_window',
      chapterId: CHAPTER_ID,
      plannedParagraphIds: [PARAGRAPH_IDS[1]!],
    };
    const snapshot = await registerWorkflow('fingerprint-retry-workflow', [job]);
    const payload = {
      kind: 'label_window',
      chapterId: CHAPTER_ID,
      segments: [segment(PARAGRAPH_IDS[1]!, 0, 5)],
    } as const;
    const stale = await stage('fingerprint-retry-workflow', job, payload, snapshot);
    await saveCorrection({
      id: 'fingerprint-retry-correction',
      novelId: NOVEL_ID,
      chapterId: CHAPTER_ID,
      paragraphId: PARAGRAPH_IDS[1],
      correctionType: 'speaker',
      afterJson: JSON.stringify({ speakerId: 'character-user' }),
      applyScope: 'chapter',
      createdAt: '2026-07-11T02:00:00.000Z',
    });
    expect(await promoteNativeAnalysisOutput(stale.artifact.id)).toMatchObject({
      status: 'stale',
      reason: 'correction_fingerprint_stale',
    });

    const refreshedSnapshot = await getNativeAnalysisPromotionSnapshot(NOVEL_ID, CHAPTER_ID);
    const retry = await stage('fingerprint-retry-workflow', job, payload, refreshedSnapshot);
    expect(retry.artifact.id).not.toBe(stale.artifact.id);
    expect((await stageNativeAnalysisOutput(retry.input)).id).toBe(retry.artifact.id);
    expect((await promoteNativeAnalysisOutput(retry.artifact.id)).status).toBe('promoted');
    expect(await aiEvents('chapter_segments_updated')).toHaveLength(1);
  });

  it('rechecks graph and correction fingerprints before label promotion', async () => {
    const job: NativeAnalysisWorkflowJobPlan = {
      jobId: 'fingerprint-job',
      artifactType: 'label_window',
      chapterId: CHAPTER_ID,
      plannedParagraphIds: [PARAGRAPH_IDS[1]!],
    };
    const snapshot = await registerWorkflow('fingerprint-workflow', [job]);
    const payload = {
      kind: 'label_window',
      chapterId: CHAPTER_ID,
      segments: [segment(PARAGRAPH_IDS[1]!, 0, 5)],
    } as const;
    const staged = await stage('fingerprint-workflow', job, payload, snapshot);
    await putRows('characters', [
      {
        id: 'graph-change',
        novelId: NOVEL_ID,
        canonicalName: 'Changed',
        aliases: [],
        color: '#111111',
        confidence: 0.5,
        isUserConfirmed: false,
      },
    ]);
    expect(await promoteNativeAnalysisOutput(staged.artifact.id)).toMatchObject({
      status: 'stale',
      reason: 'graph_fingerprint_stale',
    });

    const correctionSnapshot = await getNativeAnalysisPromotionSnapshot(NOVEL_ID, CHAPTER_ID);
    const correctionJob = { ...job, jobId: 'correction-job' };
    await saveNativeAnalysisWorkflowFence({
      workflowId: 'correction-workflow',
      novelId: NOVEL_ID,
      contentRevisionId: correctionSnapshot.activeContentRevisionId,
      planHash: 'plan:correction-workflow',
      fence: 1,
      jobs: [correctionJob],
    });
    const correctionStage = await stage('correction-workflow', correctionJob, payload, correctionSnapshot);
    const correction: UserCorrection = {
      id: 'late-correction',
      novelId: NOVEL_ID,
      chapterId: CHAPTER_ID,
      paragraphId: PARAGRAPH_IDS[1],
      correctionType: 'speaker',
      afterJson: JSON.stringify({ speakerId: 'character-user' }),
      applyScope: 'chapter',
      createdAt: '2026-07-11T01:00:00.000Z',
    };
    await saveCorrection(correction);
    expect(await promoteNativeAnalysisOutput(correctionStage.artifact.id)).toMatchObject({
      status: 'stale',
      reason: 'correction_fingerprint_stale',
    });
    expect(await aiEvents('chapter_segments_updated')).toHaveLength(0);
  });
});
