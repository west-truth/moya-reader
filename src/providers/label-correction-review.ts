import type { LabeledSegment } from '../domain/types';

export const DEFAULT_LABEL_REVIEW_CONFIDENCE_THRESHOLD = 0.65;

export const LABEL_CORRECTION_EMOTION_OPTIONS = [
  'neutral',
  'calm',
  'warm',
  'happy',
  'sad',
  'angry',
  'tense',
  'fearful',
  'surprised',
  'systematic',
] as const;

export type LabelCorrectionReason = 'unknown_speaker' | 'low_confidence' | 'multiple_candidates';

export interface LabelCorrectionReviewItem {
  readonly segment: LabeledSegment;
  readonly reasons: LabelCorrectionReason[];
}

export interface BuildLabelCorrectionReviewItemsInput {
  readonly segments: LabeledSegment[];
  readonly confidenceThreshold?: number;
}

export interface ApplyLabelCorrectionInput {
  readonly segment: LabeledSegment;
  readonly speakerId: string;
  readonly emotion: string;
  readonly confirmSpeaker?: boolean;
}

export function groupSegmentsByParagraph(segments: LabeledSegment[]): Map<string, LabeledSegment[]> {
  const map = new Map<string, LabeledSegment[]>();
  for (const segment of segments) {
    const list = map.get(segment.paragraphId) ?? [];
    list.push(segment);
    map.set(segment.paragraphId, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.startOffset - b.startOffset || a.segmentIndex - b.segmentIndex);
  }
  return map;
}

export function labelCorrectionReasons(
  segment: LabeledSegment,
  confidenceThreshold = DEFAULT_LABEL_REVIEW_CONFIDENCE_THRESHOLD,
): LabelCorrectionReason[] {
  if (segment.isUserCorrected) return [];
  const reasons: LabelCorrectionReason[] = [];
  if (segment.speakerId === 'unknown') reasons.push('unknown_speaker');
  if (segment.confidence < confidenceThreshold) reasons.push('low_confidence');
  if (segment.candidateSpeakers.length > 1) reasons.push('multiple_candidates');
  return reasons;
}

export function buildLabelCorrectionReviewItems(
  input: BuildLabelCorrectionReviewItemsInput,
): LabelCorrectionReviewItem[] {
  return input.segments
    .map((segment) => ({
      segment,
      reasons: labelCorrectionReasons(segment, input.confidenceThreshold),
    }))
    .filter((item) => item.reasons.length > 0)
    .sort((a, b) => {
      const unknownDelta = Number(b.reasons.includes('unknown_speaker')) - Number(a.reasons.includes('unknown_speaker'));
      if (unknownDelta !== 0) return unknownDelta;
      const confidenceDelta = a.segment.confidence - b.segment.confidence;
      if (confidenceDelta !== 0) return confidenceDelta;
      return a.segment.segmentIndex - b.segment.segmentIndex;
    });
}

export function buildCorrectionEmotionOptions(currentEmotion?: string, draftEmotion?: string): string[] {
  const options = [...LABEL_CORRECTION_EMOTION_OPTIONS];
  for (const emotion of [currentEmotion, draftEmotion]) {
    const normalized = emotion?.trim();
    if (normalized && !options.includes(normalized as typeof LABEL_CORRECTION_EMOTION_OPTIONS[number])) {
      options.push(normalized as typeof LABEL_CORRECTION_EMOTION_OPTIONS[number]);
    }
  }
  return options;
}

export function applyLabelCorrection(input: ApplyLabelCorrectionInput): LabeledSegment {
  const speakerId = input.speakerId.trim() || 'unknown';
  const emotion = input.emotion.trim() || 'neutral';
  const speakerChanged = speakerId !== input.segment.speakerId;
  const confirmSpeaker = input.confirmSpeaker ?? speakerChanged;
  return {
    ...input.segment,
    speakerId,
    emotion,
    candidateSpeakers: confirmSpeaker && speakerId !== 'unknown' ? [speakerId] : input.segment.candidateSpeakers,
    confidence: confirmSpeaker ? 1 : input.segment.confidence,
    evidence: confirmSpeaker ? 'User-corrected label.' : input.segment.evidence,
    voiceProfileId: speakerId === input.segment.speakerId ? input.segment.voiceProfileId : undefined,
    isUserCorrected: input.segment.isUserCorrected || confirmSpeaker,
  };
}
