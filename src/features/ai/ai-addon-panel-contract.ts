import type { AnalysisWorkflowContributionDescriptor, ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { ReactNode } from 'react';
import type { Character, LabeledSegment, UserCorrection } from '../../domain/types';
import type { ReaderMode } from '../reader/reader-screen-contract';
import type { BookAIWorkflowReviewItem } from '../../providers/book-ai-workflow-review';
import type { ProviderCatalogItem } from '../../providers/provider-jobs';
import type { LabelCorrectionReason } from '../../providers/label-correction-review';
import type { ProviderSettingsDraft } from '../../providers/provider-settings-ui';
import type { RemoteProviderJob } from '../../services/remote/remote-api-client';
import type { ProviderSettingsPanelController } from '../providers/ProviderSettingsPanel';
import type { ChapterLabelAnalysisReviewArtifact } from '../../providers/analysis-review';
import type { ChapterLabelingResult } from '../../providers/ai';
import type { AnalysisReviewEditIntentMap } from '../../providers/analysis-review-correction';
import type { CompactSpeakerWorkflowView } from './book-ai-workflow-view';

export interface AIWorkflowReadinessData {
  readonly ok: boolean;
  readonly segmentCount: number;
  readonly missingParagraphCount: number;
  readonly missingVoiceCount: number;
  readonly unknownPercent: number;
}

export interface AIWorkflowCacheReadinessData {
  readonly ok: boolean;
  readonly cachedSegmentCount: number;
  readonly cacheableSegmentCount: number;
  readonly missingCachedSegmentCount: number;
  readonly cacheItemCount: number;
  readonly cachedByteSizeLabel: string;
}

export interface AIReviewWorkspaceData {
  readonly available: boolean;
  readonly reviews: readonly ChapterLabelAnalysisReviewArtifact[];
  readonly loading: boolean;
  readonly busyReviewId?: string;
  readonly error?: string;
}

export interface AIWorkflowPanelData {
  readonly stageLabel: string;
  readonly graphBundleCount: number;
  readonly labelingWindowCount: number;
  readonly succeededJobCount: number;
  readonly pendingJobCount: number;
  readonly failedJobCount: number;
  readonly labelingBudget?: {
    readonly targetCharacters: number;
    readonly contextWindowTokens: number;
    readonly reservedOutputTokens: number;
    readonly estimated: boolean;
  };
  readonly workflow?: {
    readonly status: string;
    readonly stage: string;
    readonly jobCount: number;
    readonly modelId?: string;
    readonly errorMessage?: string;
  };
  readonly compactSpeaker?: CompactSpeakerWorkflowView;
  readonly labelVoiceReadiness?: AIWorkflowReadinessData;
  readonly cacheReadiness?: AIWorkflowCacheReadinessData;
  readonly labelVoiceReady: boolean;
  readonly cacheReady: boolean;
  readonly reviewItems: readonly BookAIWorkflowReviewItem[];
  readonly reviewWorkspace: AIReviewWorkspaceData;
  readonly workflowRuntime?: 'hosted' | 'native';
  readonly error?: string;
  readonly retryDisabled: boolean;
  readonly cancelDisabled: boolean;
  readonly startDisabled: boolean;
  readonly refreshDisabled: boolean;
  readonly warmupDisabled: boolean;
  readonly cacheRefreshDisabled: boolean;
}

export interface AIAnalysisPanelData {
  readonly showDeveloperTools: boolean;
  readonly desktopProviderMode: boolean;
  readonly mockDisabled?: boolean;
  readonly desktopAnalysisDisabled: boolean;
  readonly remoteAnalysisDisabled: boolean;
  readonly labelRepairDisabled: boolean;
  readonly graphMergeDisabled: boolean;
  readonly segmentCount: number;
  readonly bundleStatusLabel: string;
  readonly providerStatusLabel: string;
  readonly remoteJob?: RemoteProviderJob;
  readonly providers: readonly ProviderCatalogItem[];
  readonly providerDraft?: ProviderSettingsDraft;
  readonly workflows: readonly (AnalysisWorkflowContributionDescriptor & {
    readonly disabled: boolean;
  })[];
}

export interface AIGraphReviewCandidateData {
  readonly id: string;
  readonly name: string;
  readonly confidence: number;
  readonly detailLabel: string;
  readonly excluded: boolean;
}

export interface AIGraphReviewData {
  readonly includedCharacterCount: number;
  readonly candidateCount: number;
  readonly newCandidateCount: number;
  readonly duplicateCandidateCount: number;
  readonly lowConfidenceCount: number;
  readonly relationCount: number;
  readonly invalidRelationCount: number;
  readonly parseError?: string;
  readonly candidates: readonly AIGraphReviewCandidateData[];
  readonly knowledge?: {
    readonly factCount: number;
    readonly genericMentionCount: number;
    readonly addressTermCount: number;
    readonly evidenceCount: number;
    readonly busy: boolean;
    readonly error?: string;
    readonly facts: readonly {
      readonly id: string;
      readonly characterName: string;
      readonly field: string;
      readonly value: string;
      readonly status: 'active' | 'candidate' | 'rejected';
      readonly locked: boolean;
      readonly evidenceCount: number;
      readonly validityLabel: string;
    }[];
    readonly mergeCandidates: readonly {
      readonly id: string;
      readonly sourceName: string;
      readonly targetName: string;
      readonly positiveReasons: readonly string[];
      readonly negativeReasons: readonly string[];
      readonly confidence: number;
      readonly applicable: boolean;
    }[];
  };
}

export interface AILabelReviewItemData {
  readonly segment: LabeledSegment;
  readonly speakerLabel: string;
  readonly reasons: readonly LabelCorrectionReason[];
  readonly snippet: string;
}

export interface AILabelCorrectionData {
  readonly segmentCount: number;
  readonly reviewItems: readonly AILabelReviewItemData[];
  readonly readerMode: ReaderMode;
  readonly characters: readonly Character[];
  readonly target?: LabeledSegment;
  readonly targetSnippet?: string;
  readonly speakerDraft: string;
  readonly speakerOptions: readonly { readonly id: string; readonly label: string }[];
  readonly candidateSpeakerOptions: readonly { readonly id: string; readonly label: string }[];
  readonly emotionDraft: string;
  readonly emotionOptions: readonly string[];
  readonly scope: UserCorrection['applyScope'];
}

export interface AIAddonPanelData {
  readonly workflow: AIWorkflowPanelData;
  readonly analysis: AIAnalysisPanelData;
  readonly graphReview?: AIGraphReviewData;
  readonly correction: AILabelCorrectionData;
}

export interface AIAddonPanelActions {
  readonly workflow: {
    retry(): void | Promise<unknown>;
    cancel(): void | Promise<unknown>;
    start(): void | Promise<unknown>;
    refresh(): void | Promise<unknown>;
    warmupBookCache(): void | Promise<unknown>;
    refreshCacheReadiness(silent?: boolean): void | Promise<unknown>;
    runReviewAction(item: BookAIWorkflowReviewItem): void | Promise<unknown>;
    refreshReviews(): void | Promise<unknown>;
    saveReviewDraft(
      reviewId: string,
      candidate: ChapterLabelingResult,
      editIntents: AnalysisReviewEditIntentMap,
    ): void | Promise<unknown>;
    approveReview(reviewId: string): void | Promise<unknown>;
    rejectReview(reviewId: string, reason?: string): void | Promise<unknown>;
  };
  readonly analysis: {
    runMock(): void | Promise<unknown>;
    runDesktop(): void | Promise<unknown>;
    runRemote(): void | Promise<unknown>;
    repairLabels(): void | Promise<unknown>;
    runWorkflow(workflowId: ExtensionContributionId): void | Promise<unknown>;
    mergeGraph(): void | Promise<unknown>;
  };
  readonly graphReview: {
    toggleCandidate(characterId: string): void;
    confirmFact?(factId: string): void | Promise<unknown>;
    rejectFact?(factId: string): void | Promise<unknown>;
    mergeCandidate?(candidateId: string): void | Promise<unknown>;
    splitFact?(factId: string, canonicalName: string): void | Promise<unknown>;
  };
  readonly correction: {
    selectSegment(segment: LabeledSegment): void | Promise<unknown>;
    setReaderMode(mode: Extract<ReaderMode, 'analysis' | 'correction'>): void;
    setSpeakerDraft(speakerId: string): void;
    setEmotionDraft(emotion: string): void;
    setScope(scope: UserCorrection['applyScope']): void;
    apply(): void | Promise<unknown>;
    close(): void;
  };
}

export interface AIAddonPanelController {
  readonly providerSettings: ProviderSettingsPanelController;
}

export interface AIManagedWorkflowSurface {
  readonly active?: AnalysisWorkflowContributionDescriptor;
  readonly options: readonly AnalysisWorkflowContributionDescriptor[];
  readonly surface?: ReactNode;
  readonly usedFallback: boolean;
  readonly switchDisabled: boolean;
  readonly switchDisabledReason?: string;
  select(workflowId: ExtensionContributionId): void;
}

export interface AIAddonPanelProps {
  readonly data: AIAddonPanelData;
  readonly actions: AIAddonPanelActions;
  readonly controller: AIAddonPanelController;
  readonly managedWorkflow: AIManagedWorkflowSurface;
}
