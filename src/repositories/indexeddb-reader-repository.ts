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
import type { ResourceMutationOptions } from '../domain/resource-revisions';
import {
  deleteBookmark,
  deleteCorrection,
  deleteNote,
  deleteNovel,
  getBookmarks,
  getChapter,
  getChapters,
  getCharacters,
  getCharacterRelations,
  getCorrections,
  getVoiceProfiles,
  getHighlights,
  getNotes,
  openBookContentRevision,
  getParagraph,
  getParagraphPage,
  getReadingPosition,
  getNovel,
  getNovels,
  getSegments,
  getSettings,
  getSyncState,
  listSyncOutbox,
  saveBookmark,
  saveCharacterGraph,
  saveCharacters,
  saveCorrection,
  saveHighlight,
  saveImportedNovel,
  saveNote,
  patchNovelMetadata,
  saveSegments,
  saveSettings,
  saveVoiceProfiles,
  saveReadingPosition,
  clearReadingPosition,
  addNovelReadingTime,
  deleteHighlight,
  discardSyncOutboxItems,
  applyRemoteSyncEvents,
} from '../storage/db';
import {
  NativeAnalysisWorkflowRepository,
  ReaderRepository,
  RevisionPinnedReaderRepository,
} from './reader-repository';
import type { BulkParagraphPageRequest } from './reader-repository';
import type { ReaderSearchPage, ReaderSearchPageRequest } from './reader-query-contract';
import { throwIfReaderSearchAborted } from './reader-query-contract';
import { ReadingPosition, SyncEvent, SyncOutboxItem, SyncOutboxQueryOptions, SyncState } from '../sync/types';
import type { CharacterRelation } from '../providers/ai';
import type {
  ApplyLabelCorrectionsCommandV2,
  ApplyLabelCorrectionsResultV2,
} from '../providers/label-mutation-contract';
import { applyLocalLabelCorrections } from '../storage/label-mutation-store';
import type {
  NativeAnalysisPromotionProvenance,
  NativeAnalysisPromotionResult,
  NativeAnalysisPromotionSnapshot,
  NativeAnalysisStagedOutput,
  NativeAnalysisWorkflowDescriptor,
  NativeAnalysisWorkflowDescriptorInput,
  NativeAnalysisWorkflowFenceInput,
  NativeAnalysisWorkflowFenceRecord,
  StageNativeAnalysisOutputInput,
} from '../storage/native-analysis-workflow';
import {
  iterateParagraphPages as iterateStoredParagraphPages,
  searchParagraphPage as searchStoredParagraphPage,
} from '../storage/reader-query-store';
import type { BookContentRevisionHandle } from '../storage/content-revision-read-handle';
import type { NovelMetadataPatch, SaveReadingPositionInput } from './reader-repository';
import {
  getVoiceCastingWorkspace,
  listAcceptedSpeakerUtterances,
  saveVoiceCastingWorkspace,
} from '../storage/voice-casting-store';

export { defaultSettings, PARAGRAPHS_PER_PAGE } from '../storage/db';

export class IndexedDbReaderRepository
  implements ReaderRepository, RevisionPinnedReaderRepository, NativeAnalysisWorkflowRepository
{
  readonly capabilities = {
    backend: 'indexeddb',
    readingTimePersistence: 'persistent',
    syncStorage: 'local_outbox',
    remoteEventApply: true,
    parsedNovelImport: 'snapshot',
  } as const;

  listNovels(options?: { includeTrash?: boolean }): Promise<Novel[]> {
    return getNovels(options);
  }

  getNovel(id: string): Promise<Novel | undefined> {
    return getNovel(id);
  }

  patchNovelMetadata(novelId: string, patch: NovelMetadataPatch): Promise<void> {
    return patchNovelMetadata(novelId, patch);
  }

  deleteNovel(novelId: string, expectedRevision?: number): Promise<void> {
    return deleteNovel(novelId, expectedRevision);
  }

  saveImportedNovel(parsed: ParsedNovel): Promise<void> {
    return saveImportedNovel(parsed);
  }

  saveReadingPosition(input: SaveReadingPositionInput): Promise<void> {
    return saveReadingPosition(input);
  }

  getReadingPosition(novelId: string): Promise<ReadingPosition | undefined> {
    return getReadingPosition(novelId);
  }

  clearReadingPosition(novelId: string): Promise<void> {
    return clearReadingPosition(novelId);
  }

  addNovelReadingTime(novelId: string, seconds: number, readAt?: string): Promise<void> {
    return addNovelReadingTime(novelId, seconds, readAt);
  }

  listChapters(novelId: string): Promise<Chapter[]> {
    return getChapters(novelId);
  }

  getChapter(id: string): Promise<Chapter | undefined> {
    return getChapter(id);
  }

  openContentRevision(novelId: string): Promise<BookContentRevisionHandle> {
    return openBookContentRevision(novelId);
  }

  async getParagraph(id: string, signal?: AbortSignal): Promise<Paragraph | undefined> {
    if (signal) throwIfReaderSearchAborted(signal);
    const paragraph = await getParagraph(id);
    if (signal) throwIfReaderSearchAborted(signal);
    return paragraph;
  }

  async getParagraphPage(
    chapterId: string,
    pageIndex: number,
    signal?: AbortSignal,
  ): Promise<ParagraphPage | undefined> {
    if (signal) throwIfReaderSearchAborted(signal);
    const page = await getParagraphPage(chapterId, pageIndex);
    if (signal) throwIfReaderSearchAborted(signal);
    return page;
  }

  searchParagraphPage(request: ReaderSearchPageRequest): Promise<ReaderSearchPage> {
    return searchStoredParagraphPage(request);
  }

  iterateParagraphPages(request: BulkParagraphPageRequest): AsyncIterable<ParagraphPage> {
    return iterateStoredParagraphPages(request);
  }

  getSettings(): Promise<ReaderSettings> {
    return getSettings();
  }

  saveSettings(settings: ReaderSettings): Promise<void> {
    return saveSettings(settings);
  }

  listBookmarks(novelId: string): Promise<Bookmark[]> {
    return getBookmarks(novelId);
  }

  saveBookmark(bookmark: Bookmark, options?: ResourceMutationOptions): Promise<void> {
    return saveBookmark(bookmark, options);
  }

  deleteBookmark(id: string, options?: ResourceMutationOptions): Promise<void> {
    return deleteBookmark(id, options);
  }

  listHighlights(novelId: string): Promise<ReaderHighlight[]> {
    return getHighlights(novelId);
  }

  saveHighlight(highlight: ReaderHighlight, options?: ResourceMutationOptions): Promise<void> {
    return saveHighlight(highlight, options);
  }

  deleteHighlight(id: string, options?: ResourceMutationOptions): Promise<void> {
    return deleteHighlight(id, options);
  }

  listNotes(novelId: string): Promise<ReaderNote[]> {
    return getNotes(novelId);
  }

  saveNote(note: ReaderNote, options?: ResourceMutationOptions): Promise<void> {
    return saveNote(note, options);
  }

  deleteNote(id: string, options?: ResourceMutationOptions): Promise<void> {
    return deleteNote(id, options);
  }

  listSegments(chapterId: string): Promise<LabeledSegment[]> {
    return getSegments(chapterId);
  }

  saveSegments(chapterId: string, segments: LabeledSegment[], options?: ResourceMutationOptions): Promise<void> {
    return saveSegments(chapterId, segments, options);
  }

  listCharacters(novelId: string): Promise<Character[]> {
    return getCharacters(novelId);
  }

  listCharacterRelations(novelId: string): Promise<CharacterRelation[]> {
    return getCharacterRelations(novelId);
  }

  saveCharacters(novelId: string, characters: Character[], options?: ResourceMutationOptions): Promise<void> {
    return saveCharacters(novelId, characters, options);
  }

  saveCharacterGraph(
    novelId: string,
    graph: { characters: Character[]; relations: CharacterRelation[] },
    options?: ResourceMutationOptions,
  ): Promise<void> {
    return saveCharacterGraph(novelId, graph, options);
  }

  listVoiceProfiles(novelId: string): Promise<VoiceProfile[]> {
    return getVoiceProfiles(novelId);
  }

  saveVoiceProfiles(novelId: string, voiceProfiles: VoiceProfile[], options?: ResourceMutationOptions): Promise<void> {
    return saveVoiceProfiles(novelId, voiceProfiles, options);
  }

  async getVoiceProductState(novelId: string) {
    const storage = await import('../storage/voice-product-store');
    return storage.getVoiceProductState(novelId);
  }

  async saveVoiceProductState(
    novelId: string,
    state: import('../providers/voice-product').VoiceProductStateV1,
  ): Promise<void> {
    const storage = await import('../storage/voice-product-store');
    return storage.saveVoiceProductState(novelId, state);
  }

  getVoiceCastingWorkspace(novelId: string) {
    return getVoiceCastingWorkspace(novelId);
  }

  saveVoiceCastingWorkspace(input: Parameters<typeof saveVoiceCastingWorkspace>[0]): Promise<void> {
    return saveVoiceCastingWorkspace(input);
  }

  listAcceptedSpeakerUtterances(input: Parameters<typeof listAcceptedSpeakerUtterances>[0]) {
    return listAcceptedSpeakerUtterances(input);
  }

  async listCorrections(novelId: string, chapterId?: string): Promise<UserCorrection[]> {
    const corrections = await getCorrections(novelId);
    return chapterId ? corrections.filter((correction) => correction.chapterId === chapterId) : corrections;
  }

  saveCorrection(correction: UserCorrection, options?: ResourceMutationOptions): Promise<void> {
    return saveCorrection(correction, options);
  }

  deleteCorrection(novelId: string, id: string, options?: ResourceMutationOptions): Promise<void> {
    return deleteCorrection(novelId, id, options);
  }

  applyLabelCorrections(command: ApplyLabelCorrectionsCommandV2): Promise<ApplyLabelCorrectionsResultV2> {
    return applyLocalLabelCorrections(command);
  }

  async getCharacterGraphKnowledgeV2(novelId: string) {
    const storage = await import('../storage/character-graph-v2-store');
    return storage.getCharacterGraphKnowledgeV2(novelId);
  }

  async saveCharacterGraphObservationsV2(
    observations: import('../providers/character-graph-v2').CharacterGraphKnowledgeV2,
  ): Promise<void> {
    const storage = await import('../storage/character-graph-v2-store');
    return storage.saveCharacterGraphObservationsV2(observations);
  }

  async applyCharacterIdentityCommandV2(command: import('../providers/character-graph-v2').CharacterIdentityCommandV2) {
    const storage = await import('../storage/character-graph-v2-store');
    return storage.applyLocalCharacterIdentityCommandV2(command);
  }

  async getNativeAnalysisPromotionSnapshot(
    novelId: string,
    chapterId?: string,
  ): Promise<NativeAnalysisPromotionSnapshot> {
    const storage = await import('../storage/native-analysis-workflow');
    return storage.getNativeAnalysisPromotionSnapshot(novelId, chapterId);
  }

  async saveNativeAnalysisWorkflowDescriptor(
    input: NativeAnalysisWorkflowDescriptorInput,
  ): Promise<NativeAnalysisWorkflowDescriptor> {
    const storage = await import('../storage/native-analysis-workflow');
    return storage.saveNativeAnalysisWorkflowDescriptor(input);
  }

  async getNativeAnalysisWorkflowDescriptor(workflowId: string): Promise<NativeAnalysisWorkflowDescriptor | undefined> {
    const storage = await import('../storage/native-analysis-workflow');
    return storage.getNativeAnalysisWorkflowDescriptor(workflowId);
  }

  async deleteNativeAnalysisWorkflowDescriptor(workflowId: string): Promise<boolean> {
    const storage = await import('../storage/native-analysis-workflow');
    return storage.deleteNativeAnalysisWorkflowDescriptor(workflowId);
  }

  async saveNativeAnalysisWorkflowFence(
    input: NativeAnalysisWorkflowFenceInput,
  ): Promise<NativeAnalysisWorkflowFenceRecord> {
    const storage = await import('../storage/native-analysis-workflow');
    return storage.saveNativeAnalysisWorkflowFence(input);
  }

  async stageNativeAnalysisOutput(input: StageNativeAnalysisOutputInput): Promise<NativeAnalysisStagedOutput> {
    const storage = await import('../storage/native-analysis-workflow');
    return storage.stageNativeAnalysisOutput(input);
  }

  async getNativeAnalysisStagedOutput(artifactId: string): Promise<NativeAnalysisStagedOutput | undefined> {
    const storage = await import('../storage/native-analysis-workflow');
    return storage.getNativeAnalysisStagedOutput(artifactId);
  }

  async listNativeAnalysisStagedOutputs(workflowId: string): Promise<NativeAnalysisStagedOutput[]> {
    const storage = await import('../storage/native-analysis-workflow');
    return storage.listNativeAnalysisStagedOutputs(workflowId);
  }

  async saveNativeAnalysisReviewDraft(
    input: Parameters<NativeAnalysisWorkflowRepository['saveNativeAnalysisReviewDraft']>[0],
  ): Promise<NativeAnalysisStagedOutput> {
    const storage = await import('../storage/native-analysis-workflow');
    return storage.saveNativeAnalysisReviewDraft(input);
  }

  async rejectNativeAnalysisReview(
    input: Parameters<NativeAnalysisWorkflowRepository['rejectNativeAnalysisReview']>[0],
  ): Promise<NativeAnalysisStagedOutput> {
    const storage = await import('../storage/native-analysis-workflow');
    return storage.rejectNativeAnalysisReview(input);
  }

  async promoteNativeAnalysisReview(
    command: Parameters<NativeAnalysisWorkflowRepository['promoteNativeAnalysisReview']>[0],
  ): Promise<ApplyLabelCorrectionsResultV2> {
    const storage = await import('../storage/native-analysis-workflow');
    return storage.promoteNativeAnalysisReview(command);
  }

  async promoteNativeAnalysisOutput(artifactId: string): Promise<NativeAnalysisPromotionResult> {
    const storage = await import('../storage/native-analysis-workflow');
    return storage.promoteNativeAnalysisOutput(artifactId);
  }

  async listNativeAnalysisProvenance(novelId: string): Promise<NativeAnalysisPromotionProvenance[]> {
    const storage = await import('../storage/native-analysis-workflow');
    return storage.listNativeAnalysisProvenance(novelId);
  }

  listSyncOutbox(status?: SyncOutboxItem['status'], options?: SyncOutboxQueryOptions): Promise<SyncOutboxItem[]> {
    return listSyncOutbox(status, options);
  }

  applyRemoteSyncEvents(events: SyncEvent[]): Promise<void> {
    return applyRemoteSyncEvents(events);
  }

  discardSyncOutboxItems(ids: string[]): Promise<SyncState> {
    return discardSyncOutboxItems(ids);
  }

  getSyncState(): Promise<SyncState> {
    return getSyncState();
  }
}

export const readerRepository = new IndexedDbReaderRepository();
