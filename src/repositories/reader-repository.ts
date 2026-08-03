import {
  Bookmark,
  Chapter,
  Character,
  LabeledSegment,
  Novel,
  Paragraph,
  ParagraphPage,
  ParsedNovel,
  ReaderHighlight,
  ReaderNote,
  ReaderSettings,
  UserCorrection,
  VoiceProfile,
} from '../domain/types';
import type { CharacterRelation } from '../providers/ai';
import type {
  ApplyLabelCorrectionsCommandV2,
  ApplyLabelCorrectionsResultV2,
} from '../providers/label-mutation-contract';
import { ReadingPosition, SyncOutboxItem, SyncState } from '../sync/types';
import type { SyncEvent } from '../sync/types';
import type {
  NativeAnalysisPromotionProvenance,
  NativeAnalysisPromotionResult,
  NativeAnalysisPromotionSnapshot,
  NativeAnalysisWorkflowDescriptor,
  NativeAnalysisWorkflowDescriptorInput,
  NativeAnalysisStagedOutput,
  NativeAnalysisWorkflowFenceInput,
  NativeAnalysisWorkflowFenceRecord,
  StageNativeAnalysisOutputInput,
} from '../storage/native-analysis-workflow';
import type { BookContentRevisionHandle } from '../storage/content-revision-read-handle';
import type { ReaderSearchPage, ReaderSearchPageRequest } from './reader-query-contract';
import type { ResourceMutationOptions } from '../domain/resource-revisions';

export interface LibraryQueries {
  listNovels(): Promise<Novel[]>;
  getNovel(id: string): Promise<Novel | undefined>;
  listChapters(novelId: string): Promise<Chapter[]>;
}

export interface ReaderQueries {
  getChapter(id: string): Promise<Chapter | undefined>;
  getParagraph(id: string, signal?: AbortSignal): Promise<Paragraph | undefined>;
  getParagraphPage(chapterId: string, pageIndex: number, signal?: AbortSignal): Promise<ParagraphPage | undefined>;
  searchParagraphPage(request: ReaderSearchPageRequest): Promise<ReaderSearchPage>;
  getReadingPosition(novelId: string): Promise<ReadingPosition | undefined>;
  getSettings(): Promise<ReaderSettings>;
}

export interface ReaderCommands {
  patchNovelMetadata(novelId: string, patch: NovelMetadataPatch): Promise<void>;
  deleteNovel(novelId: string, expectedRevision?: number): Promise<void>;
  saveImportedNovel(parsed: ParsedNovel): Promise<void>;
  saveReadingPosition(input: SaveReadingPositionInput): Promise<void>;
  clearReadingPosition(novelId: string): Promise<void>;
  addNovelReadingTime?(novelId: string, seconds: number, readAt?: string): Promise<void>;
  saveSettings(settings: ReaderSettings): Promise<void>;
}

export interface NovelMetadataPatch {
  readonly title?: string;
  readonly favorite?: boolean;
  readonly analysisStatus?: Novel['analysisStatus'];
}

export interface SaveReadingPositionInput {
  readonly novelId: string;
  readonly chapterId: string;
  readonly scrollTop: number;
  readonly chapterProgress: number;
  readonly paragraphId?: string;
  readonly paragraphIndex: number;
  readonly offsetInParagraph?: number;
}

export interface ReaderRepositoryCapabilities {
  readonly backend: 'indexeddb' | 'hosted';
  readonly readingTimePersistence: 'persistent' | 'session_only';
  readonly syncStorage: 'local_outbox' | 'remote_backend';
  readonly remoteEventApply: boolean;
  readonly parsedNovelImport: 'snapshot' | 'upload_reparse';
}

export class UnsupportedRepositoryCapabilityError extends Error {
  constructor(
    public readonly operation: string,
    public readonly capability: keyof ReaderRepositoryCapabilities,
    public readonly backend: ReaderRepositoryCapabilities['backend'],
  ) {
    super(`Repository operation ${operation} is not supported by the ${backend} backend.`);
    this.name = 'UnsupportedRepositoryCapabilityError';
  }
}

export class RepositoryEntityNotFoundError extends Error {
  constructor(
    public readonly entityType: string,
    public readonly entityId: string,
  ) {
    super(`${entityType} ${entityId} was not found.`);
    this.name = 'RepositoryEntityNotFoundError';
  }
}

export interface AnnotationRepository {
  listBookmarks(novelId: string): Promise<Bookmark[]>;
  saveBookmark(bookmark: Bookmark, options?: ResourceMutationOptions): Promise<void>;
  deleteBookmark(id: string, options?: ResourceMutationOptions): Promise<void>;

  listHighlights(novelId: string): Promise<ReaderHighlight[]>;
  saveHighlight(highlight: ReaderHighlight, options?: ResourceMutationOptions): Promise<void>;
  deleteHighlight(id: string, options?: ResourceMutationOptions): Promise<void>;

  listNotes(novelId: string): Promise<ReaderNote[]>;
  saveNote(note: ReaderNote, options?: ResourceMutationOptions): Promise<void>;
  deleteNote(id: string, options?: ResourceMutationOptions): Promise<void>;
}

export interface AnalysisArtifactRepository {
  listSegments(chapterId: string): Promise<LabeledSegment[]>;
  saveSegments(chapterId: string, segments: LabeledSegment[], options?: ResourceMutationOptions): Promise<void>;
  listCharacters(novelId: string): Promise<Character[]>;
  listCharacterRelations(novelId: string): Promise<CharacterRelation[]>;
  saveCharacters(novelId: string, characters: Character[], options?: ResourceMutationOptions): Promise<void>;
  saveCharacterGraph(
    novelId: string,
    graph: { characters: Character[]; relations: CharacterRelation[] },
    options?: ResourceMutationOptions,
  ): Promise<void>;
  listVoiceProfiles(novelId: string): Promise<VoiceProfile[]>;
  saveVoiceProfiles(novelId: string, voiceProfiles: VoiceProfile[], options?: ResourceMutationOptions): Promise<void>;
  getVoiceProductState(novelId: string): Promise<import('../providers/voice-product').VoiceProductStateV1>;
  saveVoiceProductState(
    novelId: string,
    state: import('../providers/voice-product').VoiceProductStateV1,
  ): Promise<void>;
  getVoiceCastingWorkspace?(
    novelId: string,
  ): Promise<import('../providers/voice-casting').VoiceCastingWorkspaceV1 | undefined>;
  saveVoiceCastingWorkspace?(input: {
    readonly workspace: import('../providers/voice-casting').VoiceCastingWorkspaceV1;
    readonly expectedStorageRevision: number;
  }): Promise<void>;
  listAcceptedSpeakerUtterances?(input: {
    readonly bookId: string;
    readonly contentRevisionId: string;
    readonly chapterId?: string;
  }): Promise<import('../providers/voice-casting').AcceptedSpeakerUtteranceV1[]>;
  listCorrections(novelId: string, chapterId?: string): Promise<UserCorrection[]>;
  saveCorrection(correction: UserCorrection, options?: ResourceMutationOptions): Promise<void>;
  deleteCorrection(novelId: string, id: string, options?: ResourceMutationOptions): Promise<void>;
  applyLabelCorrections(command: ApplyLabelCorrectionsCommandV2): Promise<ApplyLabelCorrectionsResultV2>;
  getCharacterGraphKnowledgeV2(
    novelId: string,
  ): Promise<import('../providers/character-graph-v2').CharacterGraphKnowledgeV2>;
  saveCharacterGraphObservationsV2(
    observations: import('../providers/character-graph-v2').CharacterGraphKnowledgeV2,
  ): Promise<void>;
  applyCharacterIdentityCommandV2(
    command: import('../providers/character-graph-v2').CharacterIdentityCommandV2,
  ): Promise<import('../providers/character-graph-v2').CharacterIdentityOperationResultV2>;
}

export interface NativeAnalysisWorkflowRepository {
  saveNativeAnalysisWorkflowDescriptor(
    input: NativeAnalysisWorkflowDescriptorInput,
  ): Promise<NativeAnalysisWorkflowDescriptor>;
  getNativeAnalysisWorkflowDescriptor(workflowId: string): Promise<NativeAnalysisWorkflowDescriptor | undefined>;
  deleteNativeAnalysisWorkflowDescriptor(workflowId: string): Promise<boolean>;
  getNativeAnalysisPromotionSnapshot(novelId: string, chapterId?: string): Promise<NativeAnalysisPromotionSnapshot>;
  saveNativeAnalysisWorkflowFence(input: NativeAnalysisWorkflowFenceInput): Promise<NativeAnalysisWorkflowFenceRecord>;
  stageNativeAnalysisOutput(input: StageNativeAnalysisOutputInput): Promise<NativeAnalysisStagedOutput>;
  getNativeAnalysisStagedOutput(artifactId: string): Promise<NativeAnalysisStagedOutput | undefined>;
  listNativeAnalysisStagedOutputs(workflowId: string): Promise<NativeAnalysisStagedOutput[]>;
  saveNativeAnalysisReviewDraft(input: {
    artifactId: string;
    expectedReviewRevision: number;
    candidate: import('../providers/ai').ChapterLabelingResult;
    editIntents: import('../providers/analysis-review-correction').AnalysisReviewEditIntentMap;
  }): Promise<NativeAnalysisStagedOutput>;
  rejectNativeAnalysisReview(input: {
    artifactId: string;
    expectedReviewRevision: number;
    reason?: string;
  }): Promise<NativeAnalysisStagedOutput>;
  promoteNativeAnalysisReview(
    command: import('../storage/native-analysis-workflow').NativeAnalysisReviewPromotionCommand,
  ): Promise<ApplyLabelCorrectionsResultV2>;
  promoteNativeAnalysisOutput(artifactId: string): Promise<NativeAnalysisPromotionResult>;
  listNativeAnalysisProvenance(novelId: string): Promise<NativeAnalysisPromotionProvenance[]>;
}

export interface SyncRepository {
  listSyncOutbox(status?: SyncOutboxItem['status']): Promise<SyncOutboxItem[]>;
  applyRemoteSyncEvents?(events: SyncEvent[]): Promise<void>;
  discardSyncOutboxItems?(ids: string[]): Promise<SyncState>;
  getSyncState(): Promise<SyncState>;
}

export interface BulkParagraphPageRequest {
  readonly chapterId: string;
  readonly signal: AbortSignal;
  readonly batchSize?: number;
}

export interface BulkBookSource {
  iterateParagraphPages(request: BulkParagraphPageRequest): AsyncIterable<ParagraphPage>;
}

export interface RevisionPinnedBookSource {
  openContentRevision(novelId: string): Promise<BookContentRevisionHandle>;
}

export interface ReaderRepository
  extends
    LibraryQueries,
    ReaderQueries,
    ReaderCommands,
    AnnotationRepository,
    AnalysisArtifactRepository,
    SyncRepository,
    BulkBookSource {
  readonly capabilities: ReaderRepositoryCapabilities;
}

export interface RevisionPinnedReaderRepository extends ReaderRepository, RevisionPinnedBookSource {}
