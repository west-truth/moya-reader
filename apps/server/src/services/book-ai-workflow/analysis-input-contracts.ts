import type { Chapter, Paragraph, UserCorrection, VoiceProfile } from '@noveldesk/contracts';
import type {
  CharacterBundleChapterInput,
  CharacterGraph,
  ChapterLabelingPreviousContext,
  MergeCharacterGraphInput,
} from '../../../../../src/providers/ai';
import type { TTSRenderSpec } from '../../../../../src/providers/tts-render-spec';
import type { ChapterLabelingValidationIssue } from '../../../../../src/providers/chapter-labeling-validator';
import type { LabelingContextPacketV2 } from '../../../../../src/providers/labeling-context-packet';
import type {
  ProviderAdmissionSnapshot,
  ProviderCapabilitySnapshot,
  ProviderTaskProfileSnapshot,
} from '../../../../../src/providers/provider-capability';
import type { SpeakerAttributionPinnedPayloadV3 } from '../../../../../src/providers/speaker-attribution/workflow-contract';

export interface PinnedParagraphAnchor {
  readonly paragraphId: string;
  readonly chapterId: string;
  readonly paragraphIndex: number;
  readonly textHash: string;
}

export interface PinnedChapterAnchor {
  readonly chapterId: string;
  readonly chapterIndex: number;
  readonly textHash: string;
}

export interface AnalysisWindowSpec {
  readonly windowId: string;
  readonly sequence: number;
  readonly chapterAnchors: readonly PinnedChapterAnchor[];
  readonly paragraphAnchors: readonly PinnedParagraphAnchor[];
  readonly contextParagraphAnchors?: readonly PinnedParagraphAnchor[];
  readonly coversFullChapter?: boolean;
  readonly finalWindowForChapter?: boolean;
}

export interface CharacterBundleSourceSnapshot {
  readonly kind: 'character_bundle';
  readonly bundleId: string;
  readonly chapters: readonly CharacterBundleChapterInput[];
  readonly previousBundleSummary?: string;
}

export interface CharacterGraphMergeSourceSnapshot {
  readonly kind: 'character_graph_merge';
  readonly discoveredGraph: CharacterGraph;
  readonly sourceContext?: MergeCharacterGraphInput['sourceContext'];
}

export interface ChapterLabelingSourceSnapshot {
  readonly kind: 'chapter_labeling';
  readonly chapter: Chapter;
  readonly paragraphs: readonly Paragraph[];
  readonly coversFullChapter: boolean;
  readonly finalWindowForChapter: boolean;
  readonly repairRequestProfile?: AnalysisInputRevision['requestProfile'];
  readonly contextPacket?: LabelingContextPacketV2;
}

export interface ChapterLabelRepairSourceSnapshot {
  readonly kind: 'chapter_label_repair';
  readonly parentInputRevisionId: string;
  readonly parentProviderJobId: string;
  readonly candidateArtifactId: string;
  readonly candidateOutputHash: string;
  readonly repairInputFingerprint: string;
  readonly repairIssues: readonly ChapterLabelingValidationIssue[];
  readonly chapter: Chapter;
  readonly paragraphs: readonly Paragraph[];
  readonly coversFullChapter: boolean;
  readonly finalWindowForChapter: boolean;
  readonly contextPacket?: LabelingContextPacketV2;
}

export interface SpeakerAttributionSourceSnapshot extends SpeakerAttributionPinnedPayloadV3 {
  readonly kind: 'speaker_attribution_v3';
  readonly coversFullChapter: boolean;
  readonly finalWindowForChapter: boolean;
}

export interface TTSSourceSnapshot {
  readonly kind: 'tts_synthesis';
  readonly chapterId: string;
  readonly segmentIds: readonly string[];
  readonly text: string;
  readonly segmentTextHashes: Readonly<Record<string, string>>;
}

export type AnalysisSourceSnapshot =
  | CharacterBundleSourceSnapshot
  | CharacterGraphMergeSourceSnapshot
  | ChapterLabelingSourceSnapshot
  | ChapterLabelRepairSourceSnapshot
  | SpeakerAttributionSourceSnapshot
  | TTSSourceSnapshot;

export function chapterLabelingSourceView(source: AnalysisSourceSnapshot):
  | {
      readonly chapter: Chapter;
      readonly paragraphs: readonly Paragraph[];
      readonly coversFullChapter: boolean;
      readonly finalWindowForChapter: boolean;
    }
  | undefined {
  if (source.kind === 'chapter_labeling' || source.kind === 'chapter_label_repair') return source;
  if (source.kind === 'speaker_attribution_v3') {
    return {
      chapter: source.canonicalSource.chapter,
      paragraphs: source.canonicalSource.paragraphs,
      coversFullChapter: source.coversFullChapter,
      finalWindowForChapter: source.finalWindowForChapter,
    };
  }
  return undefined;
}

export interface AnalysisInputRevision {
  readonly id: string;
  readonly providerJobId: string;
  readonly workflowId?: string;
  readonly userId: string;
  readonly bookId: string;
  readonly chapterId?: string;
  readonly jobType: string;
  readonly contentRevisionId: string;
  readonly contentRevisionNumber: number;
  readonly revisionFence: number;
  readonly sourceObjectId?: string;
  readonly sourceRawTextHash?: string;
  readonly normalizedTextHash: string;
  readonly characterGraphRevisionId?: string;
  readonly characterGraphFingerprint: string;
  readonly correctionFingerprint: string;
  readonly requestProfile: {
    readonly id: string;
    readonly promptVersion: string;
    readonly schemaVersion: string;
  };
  readonly providerId: string;
  readonly modelId?: string;
  readonly providerOptionsFingerprint: string;
  readonly providerOptions: Readonly<Record<string, unknown>>;
  readonly capabilitySnapshot?: ProviderCapabilitySnapshot;
  readonly taskProfileSnapshot?: ProviderTaskProfileSnapshot;
  readonly admissionSnapshot?: ProviderAdmissionSnapshot;
  readonly windowSpec: AnalysisWindowSpec;
  readonly sourceSnapshot: AnalysisSourceSnapshot;
  readonly graphSnapshot: CharacterGraph;
  readonly correctionsSnapshot: readonly UserCorrection[];
  readonly episodeContextSnapshot?: ChapterLabelingPreviousContext;
  readonly renderSpec?: TTSRenderSpec;
  readonly renderSpecHash?: string;
  readonly voiceProfileSnapshot?: VoiceProfile;
  readonly inputHash: string;
  readonly createdAt: string;
}

export interface CreateAnalysisInputRevision {
  readonly providerJobId: string;
  readonly workflowId?: string;
  readonly userId: string;
  readonly bookId: string;
  readonly chapterId?: string;
  readonly jobType: string;
  readonly contentRevisionId: string;
  readonly contentRevisionNumber: number;
  readonly revisionFence: number;
  readonly sourceObjectId?: string;
  readonly sourceRawTextHash?: string;
  readonly normalizedTextHash: string;
  readonly characterGraphRevisionId?: string;
  readonly characterGraphFingerprint: string;
  readonly correctionFingerprint: string;
  readonly requestProfile: AnalysisInputRevision['requestProfile'];
  readonly providerId: string;
  readonly modelId?: string;
  readonly providerOptionsFingerprint: string;
  readonly providerOptions: Readonly<Record<string, unknown>>;
  readonly capabilitySnapshot?: ProviderCapabilitySnapshot;
  readonly taskProfileSnapshot?: ProviderTaskProfileSnapshot;
  readonly admissionSnapshot?: ProviderAdmissionSnapshot;
  readonly windowSpec: AnalysisWindowSpec;
  readonly sourceSnapshot: AnalysisSourceSnapshot;
  readonly graphSnapshot: CharacterGraph;
  readonly correctionsSnapshot: readonly UserCorrection[];
  readonly episodeContextSnapshot?: ChapterLabelingPreviousContext;
  readonly renderSpec?: TTSRenderSpec;
  readonly renderSpecHash?: string;
  readonly voiceProfileSnapshot?: VoiceProfile;
  readonly inputHash: string;
}

export type AnalysisArtifactType = 'character_bundle' | 'character_graph' | 'chapter_labels' | 'tts_audio';

export interface AnalysisStagingArtifact {
  readonly id: string;
  readonly inputRevisionId: string;
  readonly providerJobId: string;
  readonly workflowId?: string;
  readonly bookId: string;
  readonly chapterId?: string;
  readonly artifactType: AnalysisArtifactType;
  readonly outputHash: string;
  readonly payload: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly expectedContentRevisionId: string;
  readonly expectedGraphRevisionId?: string;
  readonly status: 'staged' | 'promoted' | 'stale' | 'quarantined';
  readonly staleReason?: string;
  readonly createdAt: string;
  readonly promotedAt?: string;
}

export class AnalysisInputStaleError extends Error {
  constructor(
    readonly code:
      | 'analysis_content_revision_stale'
      | 'analysis_revision_fence_stale'
      | 'analysis_graph_revision_stale'
      | 'analysis_corrections_stale'
      | 'analysis_source_stale'
      | 'analysis_profile_stale'
      | 'analysis_render_spec_stale'
      | 'analysis_review_changed',
    message: string,
  ) {
    super(message);
    this.name = 'AnalysisInputStaleError';
  }
}
