import { describe, expect, it } from 'vitest';
import type { ChapterLabelAnalysisReviewArtifact } from '../../providers/analysis-review';
import {
  analysisReviewCandidateChanged,
  analysisReviewOperationalStatusLabel,
  analysisReviewSegmentText,
  analysisReviewSpeakerOptions,
  cloneAnalysisReviewCandidate,
  parseAnalysisReviewListeners,
  preferredAnalysisReview,
  prepareAnalysisReviewDraft,
  replaceAnalysisReviewParagraphWithNarration,
  updateAnalysisReviewProsody,
  updateAnalysisReviewSegment,
} from './analysis-review-workspace-model';

function review(status: ChapterLabelAnalysisReviewArtifact['status'] = 'open'): ChapterLabelAnalysisReviewArtifact {
  return {
    id: `review-${status}`,
    workflowId: 'workflow-1',
    providerJobId: 'job-1',
    inputRevisionId: 'revision-1',
    stagingArtifactId: 'artifact-1',
    reviewKind: 'chapter_labeling',
    windowId: 'window-1',
    chapterId: 'chapter-1',
    chapter: {
      id: 'chapter-1',
      novelId: 'book-1',
      index: 0,
      title: '1화',
      normalizedText: '안녕 세계',
      textHash: 'chapter-hash',
      characterCount: 5,
      paragraphCount: 1,
      rawStartOffset: 0,
      rawEndOffset: 5,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    },
    paragraphs: [
      {
        id: 'paragraph-1',
        novelId: 'book-1',
        chapterId: 'chapter-1',
        index: 0,
        text: '안녕 세계',
        startOffsetInChapter: 0,
        endOffsetInChapter: 5,
        textHash: 'paragraph-hash',
      },
    ],
    haloParagraphs: [],
    characterOptions: [{ id: 'character-1', canonicalName: '주인공', aliases: ['나'] }],
    candidate: {
      characters: [
        {
          id: 'character-1',
          novelId: 'book-1',
          canonicalName: '주인공',
          aliases: [],
          color: '#111111',
          confidence: 1,
          isUserConfirmed: false,
        },
      ],
      segments: [
        {
          id: 'segment-1',
          novelId: 'book-1',
          chapterId: 'chapter-1',
          paragraphId: 'paragraph-1',
          segmentIndex: 0,
          startOffset: 0,
          endOffset: 2,
          segmentTextHash: 'segment-hash',
          type: 'quoted_dialogue',
          speakerId: 'unknown',
          candidateSpeakers: ['character-1'],
          listenerIds: [],
          emotion: 'neutral',
          confidence: 0.5,
          isUserCorrected: false,
        },
      ],
    },
    candidateHash: 'candidate-hash',
    originalCandidate: {
      characters: [],
      segments: [],
    },
    originalCandidateHash: 'original-candidate-hash',
    editIntents: {},
    validationIssues: [],
    qualityIssues: [],
    validationSummary: { errorCount: 0, warningCount: 0, issueCodes: [] },
    qualitySummary: { errorCount: 0, warningCount: 0, issueCodes: [] },
    status,
    reviewRevision: 1,
    contentRevisionId: 'content-1',
    revisionFence: 1,
    graphFingerprint: 'graph-hash',
    correctionFingerprint: 'correction-hash',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}

describe('analysis review workspace model', () => {
  it('distinguishes retrying and blocked promotion states', () => {
    expect(
      analysisReviewOperationalStatusLabel({ ...review('approved'), nextReconcileAt: '2026-07-11T01:00:00Z' }),
    ).toBe('반영 재시도 대기');
    expect(
      analysisReviewOperationalStatusLabel({ ...review('approved'), promotionLastErrorCode: 'candidate_invalid' }),
    ).toBe('반영 차단됨');
  });

  it('prefers active review artifacts and extracts source text', () => {
    const promoted = review('promoted');
    const editing = review('editing');

    expect(preferredAnalysisReview([promoted, editing])).toBe(editing);
    expect(analysisReviewSegmentText(editing, editing.candidate.segments[0])).toBe('안녕');
    expect(analysisReviewSpeakerOptions(editing, editing.candidate)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'character-1', label: '주인공 · character-1' })]),
    );
  });

  it('edits only the selected segment and keeps normalized prosody/listener values', () => {
    const artifact = review();
    const original = cloneAnalysisReviewCandidate(artifact.candidate);
    const labeled = updateAnalysisReviewSegment(original, 'segment-1', {
      speakerId: 'character-1',
      listenerIds: parseAnalysisReviewListeners('unknown, character-1, unknown'),
      emotion: 'happy',
    });
    const withProsody = updateAnalysisReviewProsody(labeled, 'segment-1', 'delivery', 'soft');

    expect(artifact.candidate.segments[0].speakerId).toBe('unknown');
    expect(withProsody.segments[0]).toMatchObject({
      speakerId: 'character-1',
      listenerIds: ['unknown', 'character-1'],
      emotion: 'happy',
    });
    expect(withProsody.segmentAnnotations?.['segment-1']?.prosodyIntent).toEqual({ delivery: 'soft' });
    expect(analysisReviewCandidateChanged(artifact.candidate, withProsody)).toBe(true);
  });

  it('repairs immutable source anchors and provides a full-paragraph narration fallback', () => {
    const artifact = review();
    const prepared = prepareAnalysisReviewDraft(artifact);
    expect(prepared.segments[0]).toMatchObject({
      id: expect.stringMatching(/^segment_[a-f0-9]{32}$/),
      segmentTextHash: expect.stringMatching(/^sha256:/),
    });

    const fallback = replaceAnalysisReviewParagraphWithNarration(artifact, prepared, artifact.paragraphs[0]);
    expect(fallback.segments).toHaveLength(1);
    expect(fallback.segments[0]).toMatchObject({
      paragraphId: 'paragraph-1',
      startOffset: 0,
      endOffset: 5,
      type: 'narration',
      speakerId: 'narrator',
      isUserCorrected: true,
    });
  });
});
