import type { LabeledSegment, Paragraph, SegmentType } from '../../domain/types';
import { labeledSegmentId, segmentTextIntegrityHash } from '../../domain/identity/ai-identities';
import type { ChapterLabelAnalysisReviewArtifact } from '../../providers/analysis-review';
import type { ChapterLabelingResult } from '../../providers/ai';
import type { AnalysisReviewEditIntentMap } from '../../providers/analysis-review-correction';

export const EDITABLE_ANALYSIS_REVIEW_STATUSES = new Set(['open', 'editing', 'validating']);
export const ACTIVE_ANALYSIS_REVIEW_STATUSES = new Set(['open', 'editing', 'validating', 'approved', 'promoting']);

export function analysisReviewStatusLabel(status: ChapterLabelAnalysisReviewArtifact['status']): string {
  const labels: Record<ChapterLabelAnalysisReviewArtifact['status'], string> = {
    open: '검토 대기',
    editing: '편집 중',
    validating: '검증 중',
    approved: '승인됨',
    rejected: '반려됨',
    obsolete: '원문 변경됨',
    promoting: '반영 중',
    promoted: '반영 완료',
  };
  return labels[status];
}

export function analysisReviewOperationalStatusLabel(review: ChapterLabelAnalysisReviewArtifact): string {
  if (review.status === 'promoted' && review.nextReconcileAt) return '워크플로 재개 중';
  if (!['approved', 'promoting'].includes(review.status)) return analysisReviewStatusLabel(review.status);
  if (review.promotionLastErrorCode && !review.nextReconcileAt) return '반영 차단됨';
  if (review.nextReconcileAt) return '반영 재시도 대기';
  return analysisReviewStatusLabel(review.status);
}

export function preferredAnalysisReview(
  reviews: readonly ChapterLabelAnalysisReviewArtifact[],
): ChapterLabelAnalysisReviewArtifact | undefined {
  return reviews.find((review) => ACTIVE_ANALYSIS_REVIEW_STATUSES.has(review.status)) ?? reviews[0];
}

export function cloneAnalysisReviewCandidate(candidate: ChapterLabelingResult): ChapterLabelingResult {
  return JSON.parse(JSON.stringify(candidate)) as ChapterLabelingResult;
}

export function prepareAnalysisReviewDraft(review: ChapterLabelAnalysisReviewArtifact): ChapterLabelingResult {
  const draft = cloneAnalysisReviewCandidate(review.candidate);
  const annotationByOldId = draft.segmentAnnotations ?? {};
  const idByOldId = new Map<string, string>();
  const segments = draft.segments.map((segment) => {
    const text = analysisReviewSegmentText(review, segment);
    const segmentTextHash = segmentTextIntegrityHash(text);
    const id = labeledSegmentId({
      novelId: segment.novelId,
      chapterId: segment.chapterId,
      paragraphId: segment.paragraphId,
      startOffset: segment.startOffset,
      endOffset: segment.endOffset,
      segmentTextHash,
    });
    idByOldId.set(segment.id, id);
    return { ...segment, id, segmentTextHash };
  });
  const segmentAnnotations = Object.fromEntries(
    Object.entries(annotationByOldId)
      .map(([segmentId, annotation]) => [idByOldId.get(segmentId), annotation] as const)
      .filter((entry): entry is readonly [string, (typeof annotationByOldId)[string]] => Boolean(entry[0])),
  );
  return {
    ...draft,
    segments,
    segmentAnnotations: Object.keys(segmentAnnotations).length > 0 ? segmentAnnotations : undefined,
  };
}

export function analysisReviewCandidateChanged(saved: ChapterLabelingResult, draft: ChapterLabelingResult): boolean {
  return JSON.stringify(saved) !== JSON.stringify(draft);
}

export function analysisReviewEditIntentsChanged(
  saved: AnalysisReviewEditIntentMap,
  draft: AnalysisReviewEditIntentMap,
): boolean {
  return JSON.stringify(saved) !== JSON.stringify(draft);
}

export function analysisReviewSegmentText(review: ChapterLabelAnalysisReviewArtifact, segment: LabeledSegment): string {
  const paragraph = review.paragraphs.find((item) => item.id === segment.paragraphId);
  if (!paragraph) return '';
  return paragraph.text.slice(segment.startOffset, segment.endOffset);
}

export function analysisReviewSpeakerOptions(
  review: ChapterLabelAnalysisReviewArtifact,
  candidate: ChapterLabelingResult,
): Array<{ readonly id: string; readonly label: string }> {
  const names = new Map([
    ...review.characterOptions.map((character) => [character.id, character.canonicalName] as const),
    ...candidate.characters.map((character) => [character.id, character.canonicalName] as const),
  ]);
  const ids = new Set(['narrator', 'system', 'unknown']);
  for (const segment of candidate.segments) {
    ids.add(segment.speakerId);
    segment.candidateSpeakers.forEach((id) => ids.add(id));
    segment.listenerIds.forEach((id) => ids.add(id));
  }
  review.characterOptions.forEach((character) => ids.add(character.id));
  review.candidate.characters.forEach((character) => ids.add(character.id));
  return [...ids]
    .filter(Boolean)
    .sort((left, right) => (names.get(left) ?? left).localeCompare(names.get(right) ?? right, 'ko'))
    .map((id) => ({ id, label: names.get(id) ? `${names.get(id)} · ${id}` : id }));
}

export function updateAnalysisReviewSegment(
  candidate: ChapterLabelingResult,
  segmentId: string,
  patch: Partial<Pick<LabeledSegment, 'type' | 'speakerId' | 'listenerIds' | 'emotion'>>,
): ChapterLabelingResult {
  return {
    ...candidate,
    segments: candidate.segments.map((segment) =>
      segment.id === segmentId ? { ...segment, ...patch, isUserCorrected: true } : segment,
    ),
  };
}

export function replaceAnalysisReviewParagraphWithNarration(
  review: ChapterLabelAnalysisReviewArtifact,
  candidate: ChapterLabelingResult,
  paragraph: Paragraph,
): ChapterLabelingResult {
  const removedIds = new Set(
    candidate.segments.filter((segment) => segment.paragraphId === paragraph.id).map((segment) => segment.id),
  );
  const segmentTextHash = segmentTextIntegrityHash(paragraph.text);
  const replacement: LabeledSegment = {
    id: labeledSegmentId({
      novelId: paragraph.novelId,
      chapterId: paragraph.chapterId,
      paragraphId: paragraph.id,
      startOffset: 0,
      endOffset: paragraph.text.length,
      segmentTextHash,
    }),
    novelId: paragraph.novelId,
    chapterId: paragraph.chapterId,
    paragraphId: paragraph.id,
    segmentIndex: 0,
    startOffset: 0,
    endOffset: paragraph.text.length,
    segmentTextHash,
    type: 'narration' satisfies SegmentType,
    speakerId: 'narrator',
    candidateSpeakers: ['narrator'],
    listenerIds: [],
    emotion: 'neutral',
    confidence: 1,
    evidence: 'manual_review_fallback',
    isUserCorrected: true,
  };
  const paragraphOrder = new Map(review.paragraphs.map((item, index) => [item.id, index]));
  const segments = [...candidate.segments.filter((segment) => !removedIds.has(segment.id)), replacement]
    .sort(
      (left, right) =>
        (paragraphOrder.get(left.paragraphId) ?? Number.MAX_SAFE_INTEGER) -
          (paragraphOrder.get(right.paragraphId) ?? Number.MAX_SAFE_INTEGER) || left.startOffset - right.startOffset,
    )
    .map((segment, index, all) => ({
      ...segment,
      segmentIndex: all.slice(0, index).filter((item) => item.paragraphId === segment.paragraphId).length,
    }));
  const segmentAnnotations = Object.fromEntries(
    Object.entries(candidate.segmentAnnotations ?? {}).filter(([segmentId]) => !removedIds.has(segmentId)),
  );
  return {
    ...candidate,
    segments,
    uncertainties: candidate.uncertainties?.filter((item) => item.paragraphId !== paragraph.id),
    segmentAnnotations: Object.keys(segmentAnnotations).length > 0 ? segmentAnnotations : undefined,
  };
}

export function updateAnalysisReviewProsody(
  candidate: ChapterLabelingResult,
  segmentId: string,
  field: 'pace' | 'intensity' | 'delivery',
  value: string | undefined,
): ChapterLabelingResult {
  const previous = candidate.segmentAnnotations?.[segmentId] ?? { evidenceCodes: [] };
  const prosodyIntent = { ...previous.prosodyIntent, [field]: value || undefined };
  return {
    ...candidate,
    segmentAnnotations: {
      ...candidate.segmentAnnotations,
      [segmentId]: { ...previous, prosodyIntent },
    },
  };
}

export function parseAnalysisReviewListeners(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
