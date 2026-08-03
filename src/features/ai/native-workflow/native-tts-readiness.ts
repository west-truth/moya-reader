import type { LabeledSegment, VoiceProfile } from '../../../domain/types';
import type { BookAIWorkflowPlan } from '../../../providers/book-ai-workflow-plan';
import type { BookAIWorkflowReviewItem } from '../../../providers/book-ai-workflow-review';
import type { NativeWorkflowFinalizationDecision } from './orchestrator';

const UNKNOWN_SPEAKER_REVIEW_RATIO = 0.25;
const ROLE_SPEAKER_IDS = new Set(['narrator', 'system', 'unknown']);

export interface NativeTTSReadinessRepository {
  listSegments(chapterId: string): Promise<LabeledSegment[]>;
  listVoiceProfiles(novelId: string): Promise<VoiceProfile[]>;
}

export interface NativeTTSReadinessMetrics {
  readonly plannedParagraphCount: number;
  readonly labeledParagraphCount: number;
  readonly missingPlannedParagraphCount: number;
  readonly segmentCount: number;
  readonly unknownSegmentCount: number;
  readonly unknownSegmentRatio: number;
  readonly characterSpeakerCount: number;
  readonly missingCharacterVoiceProfileCount: number;
}

export interface NativeTTSReadinessResult extends NativeWorkflowFinalizationDecision {
  readonly reviewItems: readonly BookAIWorkflowReviewItem[];
  readonly metrics: NativeTTSReadinessMetrics;
  readonly missingPlannedParagraphIds: readonly string[];
  readonly missingCharacterVoiceSpeakerIds: readonly string[];
}

function selectedCharacterVoiceIds(profiles: readonly VoiceProfile[]): Set<string> {
  return new Set(
    profiles
      .filter(
        (profile) =>
          profile.role === 'character' &&
          profile.isUserSelected &&
          Boolean(profile.characterId?.trim()) &&
          Boolean(profile.providerId.trim()) &&
          Boolean(profile.providerVoiceId.trim()),
      )
      .map((profile) => profile.characterId!),
  );
}

function missingParagraphsReviewItem(paragraphIds: readonly string[]): BookAIWorkflowReviewItem {
  return {
    id: 'tts_readiness:missing_paragraph_labels',
    kind: 'missing_paragraph_labels',
    severity: 'error',
    title: '라벨이 없는 예정 문단',
    detail: `${paragraphIds.length}개 예정 문단의 화자/감정 라벨이 비어 있습니다.`,
    recommendedAction: 'retry_workflow',
    actionLabel: '누락 라벨 재생성',
    paragraphIds: paragraphIds.slice(0, 100),
    errorCode: 'tts_readiness_missing_paragraphs',
  };
}

function missingVoicesReviewItem(speakerIds: readonly string[]): BookAIWorkflowReviewItem {
  return {
    id: 'tts_readiness:missing_voice_profiles',
    kind: 'missing_voice_profiles',
    severity: 'warning',
    title: '캐릭터별 TTS 음성 미지정',
    detail: `${speakerIds.length}명 캐릭터에 사용할 음성이 없습니다.`,
    recommendedAction: 'assign_voice_profiles',
    actionLabel: 'TTS 탭에서 음성 배정',
    speakerIds: speakerIds.slice(0, 100),
    errorCode: 'tts_readiness_missing_voice_profiles',
  };
}

function unknownRatioReviewItem(ratio: number): BookAIWorkflowReviewItem {
  return {
    id: 'tts_readiness:high_unknown_speaker_ratio',
    kind: 'high_unknown_speaker_ratio',
    severity: 'warning',
    title: '알 수 없는 화자 비율 높음',
    detail: `unknown speaker segment 비율이 ${Math.round(ratio * 100)}%입니다.`,
    recommendedAction: 'review_labels',
    actionLabel: '라벨 검토 후 재시도',
    errorCode: 'tts_readiness_unknown_speaker_ratio_high',
  };
}

export async function evaluateNativeTTSReadiness(input: {
  readonly novelId: string;
  readonly plan: BookAIWorkflowPlan;
  readonly repository: NativeTTSReadinessRepository;
}): Promise<NativeTTSReadinessResult> {
  const [chapterSegments, voiceProfiles] = await Promise.all([
    Promise.all(input.plan.ttsReady.chapterIds.map((chapterId) => input.repository.listSegments(chapterId))),
    input.repository.listVoiceProfiles(input.novelId),
  ]);
  const segments = chapterSegments.flat();
  const plannedParagraphIds = new Set(input.plan.labelingWindows.flatMap((window) => window.paragraphIds));
  const labeledParagraphIds = new Set(segments.map((segment) => segment.paragraphId));
  const missingPlannedParagraphIds = [...plannedParagraphIds].filter((id) => !labeledParagraphIds.has(id));
  const unknownSegmentCount = segments.filter((segment) => segment.speakerId === 'unknown').length;
  const unknownSegmentRatio = segments.length > 0 ? unknownSegmentCount / segments.length : 1;
  const characterSpeakerIds = new Set(
    segments.map((segment) => segment.speakerId).filter((speakerId) => !ROLE_SPEAKER_IDS.has(speakerId)),
  );
  const selectedVoices = selectedCharacterVoiceIds(voiceProfiles);
  const missingCharacterVoiceSpeakerIds = [...characterSpeakerIds].filter(
    (speakerId) => !selectedVoices.has(speakerId),
  );
  const reviewItems: BookAIWorkflowReviewItem[] = [];
  if (missingPlannedParagraphIds.length > 0) reviewItems.push(missingParagraphsReviewItem(missingPlannedParagraphIds));
  if (missingCharacterVoiceSpeakerIds.length > 0)
    reviewItems.push(missingVoicesReviewItem(missingCharacterVoiceSpeakerIds));
  if (unknownSegmentRatio > UNKNOWN_SPEAKER_REVIEW_RATIO) reviewItems.push(unknownRatioReviewItem(unknownSegmentRatio));

  return {
    outcome: reviewItems.length > 0 ? 'needs_review' : 'ready_for_tts',
    reviewItems,
    metrics: {
      plannedParagraphCount: plannedParagraphIds.size,
      labeledParagraphCount: [...plannedParagraphIds].filter((id) => labeledParagraphIds.has(id)).length,
      missingPlannedParagraphCount: missingPlannedParagraphIds.length,
      segmentCount: segments.length,
      unknownSegmentCount,
      unknownSegmentRatio,
      characterSpeakerCount: characterSpeakerIds.size,
      missingCharacterVoiceProfileCount: missingCharacterVoiceSpeakerIds.length,
    },
    missingPlannedParagraphIds,
    missingCharacterVoiceSpeakerIds,
  };
}
