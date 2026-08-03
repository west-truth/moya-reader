export const SPEAKER_SOURCE_MANIFEST_VERSION = 'speaker-source-manifest-v1' as const;
export const SPEAKER_SCENE_INVENTORY_VERSION = 'speaker-scene-inventory-v1' as const;
export const SPEAKER_SPAN_INVENTORY_VERSION = 'speaker-span-inventory-v1' as const;
export const DIALOGUE_BURST_INVENTORY_VERSION = 'dialogue-burst-inventory-v1' as const;
export const SPAN_BOUNDARY_PATCH_VERSION = 'span-boundary-patch-v1' as const;

export interface SpeakerSourceChapterInput {
  readonly chapterId: string;
  readonly chapterIndex: number;
  readonly sourceStartOffset: number;
  readonly sourceEndOffset: number;
  readonly bodyStartOffset: number;
  readonly bodyEndOffset: number;
  readonly text: string;
  readonly textHash: string;
  readonly paragraphCount: number;
}

export interface SpeakerSourceParagraphInput {
  readonly paragraphId: string;
  readonly chapterId: string;
  readonly paragraphIndex: number;
  readonly text: string;
  readonly textHash: string;
  readonly startOffsetInChapter: number;
  readonly endOffsetInChapter: number;
}

export type SpeakerSourcePreflightIssueCode =
  | 'content_revision_stale'
  | 'normalized_source_hash_mismatch'
  | 'chapter_id_duplicate'
  | 'chapter_index_duplicate'
  | 'chapter_index_gap'
  | 'chapter_range_invalid'
  | 'chapter_range_gap_or_overlap'
  | 'chapter_body_hash_mismatch'
  | 'chapter_body_source_mismatch'
  | 'empty_chapter'
  | 'expected_chapter_count_mismatch'
  | 'suspicious_oversized_chapter';

export interface SpeakerSourcePreflightIssueV1 {
  readonly code: SpeakerSourcePreflightIssueCode;
  readonly severity: 'error' | 'review';
  readonly chapterId?: string;
  readonly detail: string;
}

export interface SpeakerSourceManifestV1 {
  readonly version: typeof SPEAKER_SOURCE_MANIFEST_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly sourceHash: string;
  readonly normalizedTextHash: string;
  readonly expectedChapterCount?: number;
  readonly acceptedChapterCount: number;
  readonly chapterAnchors: readonly {
    readonly chapterId: string;
    readonly chapterIndex: number;
    readonly startOffset: number;
    readonly endOffset: number;
    readonly bodyStartOffset: number;
    readonly bodyEndOffset: number;
    readonly textHash: string;
  }[];
  readonly issues: readonly SpeakerSourcePreflightIssueV1[];
  readonly status: 'ready' | 'review_required' | 'stale';
  readonly fingerprint: string;
}

export interface SpeakerSceneV1 {
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly chapterIndex: number;
  readonly sceneIndex: number;
  readonly firstParagraphId: string;
  readonly lastParagraphId: string;
  readonly paragraphIds: readonly string[];
  readonly boundaryCode: 'chapter_start' | 'separator' | 'section_heading' | 'source_gap';
  readonly detectorVersion: string;
  readonly fingerprint: string;
}

export interface SpeakerSceneInventoryV1 {
  readonly version: typeof SPEAKER_SCENE_INVENTORY_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly detectorVersion: string;
  readonly scenes: readonly SpeakerSceneV1[];
  readonly fingerprint: string;
}

export type SpeakerSpanType =
  'narration' | 'dialogue' | 'inner_monologue' | 'message' | 'system' | 'sfx' | 'metadata' | 'unknown';

export interface SpeakerSpanV1 {
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly paragraphId: string;
  readonly sceneId: string;
  readonly spanIndex: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly textHash: string;
  readonly type: SpeakerSpanType;
  readonly voiceBearing: boolean;
  readonly boundaryReview: boolean;
  readonly boundaryCode: string;
  readonly deterministicSpeaker?: 'narrator' | 'system';
  readonly lockedCorrectionId?: string;
}

export interface LockedSpeakerSpanV1 {
  readonly paragraphId: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly textHash: string;
  readonly type: SpeakerSpanType;
  readonly speakerId: string;
  readonly correctionId: string;
}

export interface SpeakerSpanInventoryV1 {
  readonly version: typeof SPEAKER_SPAN_INVENTORY_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly detectorVersion: string;
  readonly spans: readonly SpeakerSpanV1[];
  readonly boundaryReviewSpanIds: readonly string[];
  readonly fingerprint: string;
}

export interface DialogueBurstV1 {
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly sceneId: string;
  readonly burstIndex: number;
  readonly spanIds: readonly string[];
  readonly targetSpanIndexes: readonly number[];
  readonly participantCandidateIds: readonly string[];
  readonly alternationMode: 'none' | 'two_party_soft' | 'multi_party';
  readonly splitReason?: 'target_budget' | 'candidate_hard_cap';
  readonly detectorVersion: string;
  readonly fingerprint: string;
}

export interface DialogueBurstInventoryV1 {
  readonly version: typeof DIALOGUE_BURST_INVENTORY_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly detectorVersion: string;
  readonly bursts: readonly DialogueBurstV1[];
  readonly fingerprint: string;
}

export type SpanBoundaryPatchOperationV1 =
  | {
      readonly kind: 'split';
      readonly spanId: string;
      readonly splitOffsets: readonly number[];
      readonly resultTypes?: readonly SpeakerSpanType[];
    }
  | {
      readonly kind: 'merge';
      readonly spanIds: readonly string[];
      readonly resultType?: SpeakerSpanType;
    };

export interface SpanBoundaryPatchV1 {
  readonly version: typeof SPAN_BOUNDARY_PATCH_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly expectedInventoryHash: string;
  readonly operations: readonly SpanBoundaryPatchOperationV1[];
  readonly createdBy: 'user' | 'provider_review';
  readonly createdAt: string;
  readonly fingerprint: string;
}
