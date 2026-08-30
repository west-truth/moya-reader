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
import { ReaderRepository } from './reader-repository';
import type { BulkParagraphPageRequest } from './reader-repository';
import type { SaveReadingPositionInput } from './reader-repository';
import type { ReaderSearchPage, ReaderSearchPageRequest } from './reader-query-contract';
import { throwIfReaderSearchAborted } from './reader-query-contract';
import {
  RemoteApiClient,
  RemoteApiError,
  mapServerBook,
  mapServerBookmark,
  mapServerChapter,
  mapServerHighlight,
  mapServerNote,
  mapServerParagraphPage,
  mapServerReadingPosition,
} from '../services/remote/remote-api-client';
import type { RemoteMutationResult } from '../services/remote/remote-api-contracts';
import { defaultSettings } from './reader-defaults';
import { ResourceRevisionConflictError, type ResourceMutationOptions } from '../domain/resource-revisions';
import { normalizeVoiceCastingWorkspace } from '../providers/voice-casting';
import { snapshotSourceRevision } from '../services/remote/remote-book-snapshot';

const FALLBACK_IMPORT_CHUNK_BYTES = 2 * 1024 * 1024;
const DEFAULT_REMOTE_DEVICE_ID = 'web_remote';

function applyPosition(novel: Novel, position?: ReadingPosition): Novel {
  if (!position) return novel;
  return {
    ...novel,
    lastReadChapterId: position.chapterId,
    lastReadParagraphId: position.paragraphId,
    lastReadOffset: position.scrollTop,
    lastReadProgress: novel.lastReadChapterIndex === undefined ? position.chapterProgress : novel.lastReadProgress,
    lastReadAt: position.updatedAt,
    updatedAt: position.updatedAt,
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof RemoteApiError && error.status === 404;
}

export class RemoteMutationConflictError extends Error {
  constructor(public readonly operation: string) {
    super('Remote mutation was not applied because the server has newer state.');
    this.name = 'RemoteMutationConflictError';
  }
}

export class RemoteMutationProtocolError extends Error {
  constructor(public readonly operation: string) {
    super('Remote mutation response did not include an explicit applied result.');
    this.name = 'RemoteMutationProtocolError';
  }
}

function ensureApplied(result: RemoteMutationResult, operation: string): void {
  if (!result || result.ok !== true) throw new RemoteMutationProtocolError(operation);
  if (result.applied === false) throw new RemoteMutationConflictError(operation);
  if (result.applied !== true) throw new RemoteMutationProtocolError(operation);
}

function remoteActualRevision(error: RemoteApiError): string {
  if (typeof error.payload === 'object' && error.payload !== null) {
    const actualRevision = (error.payload as { actualRevision?: unknown }).actualRevision;
    if (typeof actualRevision === 'string' && actualRevision) return actualRevision;
  }
  try {
    const payload = JSON.parse(error.message) as { actualRevision?: unknown };
    if (typeof payload.actualRevision === 'string' && payload.actualRevision) return payload.actualRevision;
  } catch {
    // The server may return a plain-text error body.
  }
  return 'remote-current';
}

async function runResourceMutation(
  resourceKind: string,
  options: ResourceMutationOptions | undefined,
  mutation: () => Promise<unknown>,
): Promise<void> {
  try {
    await mutation();
  } catch (error) {
    if (options && error instanceof RemoteApiError && error.status === 409) {
      throw new ResourceRevisionConflictError(resourceKind, options.expectedRevision, remoteActualRevision(error));
    }
    throw error;
  }
}

function textFromParsedNovel(parsed: ParsedNovel): string {
  if (parsed.novel.rawText) return parsed.novel.rawText;
  if (parsed.novel.normalizedText) return parsed.novel.normalizedText;
  return parsed.chapters
    .sort((a, b) => a.index - b.index)
    .map((chapter) => {
      const paragraphs = parsed.paragraphs
        .filter((paragraph) => paragraph.chapterId === chapter.id)
        .sort((a, b) => a.index - b.index)
        .map((paragraph) => paragraph.text);
      return [chapter.title, ...paragraphs].filter(Boolean).join('\n\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

async function pollImportResult(client: RemoteApiClient, jobId: string): Promise<Novel> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const job = await client.getImportJob(jobId);
    if (job.status === 'failed') throw new Error(job.error_message ?? 'Remote import failed');
    if (job.status === 'done' && job.book_id) {
      const manifest = await client.getBookManifest(job.book_id);
      return applyPosition(mapServerBook(manifest.book), mapServerReadingPosition(manifest.readingPosition));
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  throw new Error('Remote import timed out');
}

export class RemoteReaderRepository implements ReaderRepository {
  readonly capabilities = {
    backend: 'hosted',
    readingTimePersistence: 'session_only',
    syncStorage: 'remote_backend',
    remoteEventApply: false,
    parsedNovelImport: 'upload_reparse',
  } as const;

  private readonly lastReaderStateMutationAtByBook = new Map<string, number>();
  private readonly contentRevisionByBook = new Map<string, string>();
  private readonly contentTargetByChapter = new Map<string, { bookId: string; contentRevisionId: string }>();
  private readonly contentTargetByParagraph = new Map<string, { bookId: string; contentRevisionId: string }>();

  constructor(
    private readonly client: RemoteApiClient,
    private readonly deviceId: string = DEFAULT_REMOTE_DEVICE_ID,
  ) {}

  private observeReaderStateTimestamp(bookId: string, updatedAt?: string): void {
    if (!updatedAt) return;
    const timestamp = Date.parse(updatedAt);
    if (Number.isFinite(timestamp)) {
      this.lastReaderStateMutationAtByBook.set(
        bookId,
        Math.max(this.lastReaderStateMutationAtByBook.get(bookId) ?? 0, timestamp),
      );
    }
  }

  private nextReaderStateTimestamp(bookId: string): string {
    const next = Math.max(Date.now(), (this.lastReaderStateMutationAtByBook.get(bookId) ?? 0) + 1);
    this.lastReaderStateMutationAtByBook.set(bookId, next);
    return new Date(next).toISOString();
  }

  private rememberNovelRevision(novel: Novel): void {
    const nextRevision = novel.activeContentRevisionId;
    if (!nextRevision) return;
    const previousRevision = this.contentRevisionByBook.get(novel.id);
    if (previousRevision && previousRevision !== nextRevision) {
      for (const [chapterId, target] of this.contentTargetByChapter) {
        if (target.bookId === novel.id) this.contentTargetByChapter.delete(chapterId);
      }
      for (const [paragraphId, target] of this.contentTargetByParagraph) {
        if (target.bookId === novel.id) this.contentTargetByParagraph.delete(paragraphId);
      }
    }
    this.contentRevisionByBook.set(novel.id, nextRevision);
  }

  private async resolveBookRevision(bookId: string): Promise<string> {
    const known = this.contentRevisionByBook.get(bookId);
    if (known) return known;
    const manifest = await this.client.getBookManifest(bookId);
    const revision = snapshotSourceRevision(manifest);
    if (!revision) throw new RemoteMutationProtocolError('book_content_revision');
    this.contentRevisionByBook.set(bookId, revision);
    return revision;
  }

  private rememberChapterTarget(chapter: Chapter, contentRevisionId: string): void {
    this.contentTargetByChapter.set(chapter.id, { bookId: chapter.novelId, contentRevisionId });
  }

  async listNovels(): Promise<Novel[]> {
    const response = await this.client.listBooks();
    const novels = response.books.map(mapServerBook);
    novels.forEach((novel) => this.rememberNovelRevision(novel));
    novels.forEach((novel) => this.observeReaderStateTimestamp(novel.id, novel.lastReadAt));
    return novels;
  }

  async getNovel(id: string): Promise<Novel | undefined> {
    try {
      const response = await this.client.getBookManifest(id);
      const position = mapServerReadingPosition(response.readingPosition);
      this.observeReaderStateTimestamp(id, position?.updatedAt);
      const novel = applyPosition(mapServerBook(response.book), position);
      this.rememberNovelRevision(novel);
      return novel;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async patchNovelMetadata(...args: Parameters<ReaderRepository['patchNovelMetadata']>): Promise<void> {
    const [novelId, patch, expectation] = args;
    await this.client.patchBook(novelId, { ...patch, ...expectation });
  }

  async deleteNovel(...args: Parameters<ReaderRepository['deleteNovel']>): Promise<void> {
    const [novelId, expectation] = args;
    await this.client.deleteBook(novelId, this.deviceId, expectation);
  }

  async saveImportedNovel(parsed: ParsedNovel): Promise<void> {
    const text = textFromParsedNovel(parsed);
    const file = new File([text], parsed.novel.sourceFileName, { type: 'text/plain' });
    const totalChunks = Math.max(1, Math.ceil(file.size / FALLBACK_IMPORT_CHUNK_BYTES));
    const upload = await this.client.initUpload({
      fileName: file.name,
      sizeBytes: file.size,
      contentType: file.type || 'text/plain',
      encoding: 'utf-8',
      totalChunks,
      clientBookId: parsed.novel.id,
    });
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      const start = chunkIndex * FALLBACK_IMPORT_CHUNK_BYTES;
      await this.client.putUploadChunk(
        upload.uploadId,
        chunkIndex,
        file.slice(start, start + FALLBACK_IMPORT_CHUNK_BYTES),
      );
    }
    const job = await this.client.completeUpload(upload.uploadId);
    await pollImportResult(this.client, job.jobId);
  }

  async saveReadingPosition(input: SaveReadingPositionInput): Promise<void> {
    const result = await this.client.saveReadingPosition(input.novelId, {
      chapterId: input.chapterId,
      expectedContentRevisionId: input.expectedContentRevisionId,
      documentSectionId: input.documentSectionId,
      paragraphId: input.paragraphId,
      paragraphIndex: input.paragraphIndex,
      offsetInParagraph: input.offsetInParagraph ?? 0,
      chapterProgress: Math.max(0, Math.min(1, input.chapterProgress)),
      scrollTop: Math.max(0, Math.round(input.scrollTop)),
      deviceId: this.deviceId,
      updatedAt: this.nextReaderStateTimestamp(input.novelId),
    });
    ensureApplied(result, 'reading_position');
  }

  async getReadingPosition(novelId: string): Promise<ReadingPosition | undefined> {
    try {
      const response = await this.client.getBookManifest(novelId);
      const position = mapServerReadingPosition(response.readingPosition);
      this.observeReaderStateTimestamp(novelId, position?.updatedAt);
      return position;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async clearReadingPosition(novelId: string, expectedContentRevisionId?: string): Promise<void> {
    const result = await this.client.deleteReadingPosition(novelId, {
      deviceId: this.deviceId,
      expectedContentRevisionId,
      updatedAt: this.nextReaderStateTimestamp(novelId),
    });
    ensureApplied(result, 'reading_position');
  }

  async listChapters(novelId: string, expectedContentRevisionId?: string): Promise<Chapter[]> {
    const contentRevisionId = expectedContentRevisionId ?? (await this.resolveBookRevision(novelId));
    const response = await this.client.listChapters(novelId, contentRevisionId);
    const chapters = response.chapters.map(mapServerChapter);
    chapters.forEach((chapter) => this.rememberChapterTarget(chapter, contentRevisionId));
    chapters.forEach((chapter) => this.observeReaderStateTimestamp(novelId, chapter.documentSectionReadAt));
    return chapters;
  }

  async getChapter(id: string): Promise<Chapter | undefined> {
    try {
      let target = this.contentTargetByChapter.get(id);
      if (!target) {
        const discovery = await this.client.getChapter(id);
        const revision = snapshotSourceRevision(discovery);
        const discovered = mapServerChapter(discovery.chapter);
        if (!revision) throw new RemoteMutationProtocolError('chapter_content_revision');
        target = { bookId: discovered.novelId, contentRevisionId: revision };
      }
      const response = await this.client.getChapter(id, target.contentRevisionId);
      const chapter = mapServerChapter(response.chapter);
      this.rememberChapterTarget(chapter, target.contentRevisionId);
      return chapter;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async getParagraph(id: string, signal?: AbortSignal): Promise<Paragraph | undefined> {
    try {
      let target = this.contentTargetByParagraph.get(id);
      if (!target) {
        const discovery = await this.client.getParagraph(id, undefined, signal);
        const revision = snapshotSourceRevision(discovery);
        if (!revision) throw new RemoteMutationProtocolError('paragraph_content_revision');
        target = { bookId: discovery.paragraph.novelId, contentRevisionId: revision };
      }
      const response = await this.client.getParagraph(id, target.contentRevisionId, signal);
      this.contentTargetByParagraph.set(id, target);
      return response.paragraph;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async getParagraphPage(
    chapterId: string,
    pageIndex: number,
    signal?: AbortSignal,
  ): Promise<ParagraphPage | undefined> {
    let target = this.contentTargetByChapter.get(chapterId);
    if (!target) {
      const chapter = await this.getChapter(chapterId);
      if (!chapter) return undefined;
      target = this.contentTargetByChapter.get(chapterId);
    }
    if (!target) throw new RemoteMutationProtocolError('chapter_content_revision');
    const response = await this.client.listPages(chapterId, pageIndex, 1, target.contentRevisionId, signal);
    const page = response.pages[0];
    const mappedPage = page ? mapServerParagraphPage(page) : undefined;
    mappedPage?.paragraphs.forEach((paragraph) => this.contentTargetByParagraph.set(paragraph.id, target!));
    return mappedPage;
  }

  searchParagraphPage(request: ReaderSearchPageRequest): Promise<ReaderSearchPage> {
    return this.client.searchParagraphPage(request);
  }

  async *iterateParagraphPages(request: BulkParagraphPageRequest): AsyncIterable<ParagraphPage> {
    let target = this.contentTargetByChapter.get(request.chapterId);
    if (!target) {
      const chapter = await this.getChapter(request.chapterId);
      if (!chapter) return;
      target = this.contentTargetByChapter.get(request.chapterId);
    }
    if (!target) throw new RemoteMutationProtocolError('chapter_content_revision');
    const batchSize = Math.min(20, Math.max(1, Math.trunc(request.batchSize ?? 20)));
    for (let from = 0; ;) {
      throwIfReaderSearchAborted(request.signal);
      const response = await this.client.listPages(
        request.chapterId,
        from,
        batchSize,
        target.contentRevisionId,
        request.signal,
      );
      throwIfReaderSearchAborted(request.signal);
      const pages = response.pages.map(mapServerParagraphPage).sort((left, right) => left.pageIndex - right.pageIndex);
      for (const page of pages) {
        throwIfReaderSearchAborted(request.signal);
        yield page;
      }
      if (pages.length < batchSize) return;
      const nextFrom = pages[pages.length - 1].pageIndex + 1;
      if (nextFrom <= from) throw new Error('Remote paragraph page cursor did not advance.');
      from = nextFrom;
    }
  }

  async getSettings(): Promise<ReaderSettings> {
    const response = await this.client.getSettings();
    return {
      ...defaultSettings,
      ...response.settings,
      ttsPlayback: {
        ...defaultSettings.ttsPlayback,
        ...response.settings.ttsPlayback,
        rate: response.settings.ttsPlayback?.rate ?? response.settings.ttsSpeed ?? defaultSettings.ttsPlayback.rate,
      },
      readingProfile: { ...defaultSettings.readingProfile, ...response.settings.readingProfile },
      aiWorkflows: {
        ...defaultSettings.aiWorkflows!,
        ...response.settings.aiWorkflows,
        bookOverrides: {
          ...defaultSettings.aiWorkflows?.bookOverrides,
          ...response.settings.aiWorkflows?.bookOverrides,
        },
      },
      gestureBindings: { ...defaultSettings.gestureBindings, ...response.settings.gestureBindings },
    };
  }

  async saveSettings(settings: ReaderSettings): Promise<void> {
    await this.client.saveSettings(settings);
  }

  async listBookmarks(novelId: string): Promise<Bookmark[]> {
    const response = await this.client.listBookmarks(novelId);
    return response.bookmarks.map(mapServerBookmark);
  }

  async saveBookmark(bookmark: Bookmark, options?: ResourceMutationOptions): Promise<void> {
    await runResourceMutation('bookmark', options, async () => {
      ensureApplied(
        await (options ? this.client.saveBookmark(bookmark, options) : this.client.saveBookmark(bookmark)),
        'bookmark',
      );
    });
  }

  async deleteBookmark(id: string, options?: ResourceMutationOptions): Promise<void> {
    await runResourceMutation('bookmark', options, () =>
      options ? this.client.deleteBookmark(id, options) : this.client.deleteBookmark(id),
    );
  }

  async listHighlights(novelId: string): Promise<ReaderHighlight[]> {
    const response = await this.client.listHighlights(novelId);
    return response.highlights.map(mapServerHighlight);
  }

  async saveHighlight(highlight: ReaderHighlight, options?: ResourceMutationOptions): Promise<void> {
    await runResourceMutation('highlight', options, async () => {
      ensureApplied(
        await (options ? this.client.saveHighlight(highlight, options) : this.client.saveHighlight(highlight)),
        'highlight',
      );
    });
  }

  async deleteHighlight(id: string, options?: ResourceMutationOptions): Promise<void> {
    await runResourceMutation('highlight', options, () =>
      options ? this.client.deleteHighlight(id, options) : this.client.deleteHighlight(id),
    );
  }

  async listNotes(novelId: string): Promise<ReaderNote[]> {
    const response = await this.client.listNotes(novelId);
    return response.notes.map(mapServerNote);
  }

  async saveNote(note: ReaderNote, options?: ResourceMutationOptions): Promise<void> {
    await runResourceMutation('note', options, async () => {
      ensureApplied(await (options ? this.client.saveNote(note, options) : this.client.saveNote(note)), 'note');
    });
  }

  async deleteNote(id: string, options?: ResourceMutationOptions): Promise<void> {
    await runResourceMutation('note', options, () =>
      options ? this.client.deleteNote(id, options) : this.client.deleteNote(id),
    );
  }

  async listSegments(chapterId: string): Promise<LabeledSegment[]> {
    const response = await this.client.listSegments(chapterId);
    return response.segments;
  }

  async saveSegments(chapterId: string, segments: LabeledSegment[], options?: ResourceMutationOptions): Promise<void> {
    await runResourceMutation('chapter_segments', options, () =>
      options ? this.client.saveSegments(chapterId, segments, options) : this.client.saveSegments(chapterId, segments),
    );
  }

  async listCharacters(novelId: string): Promise<Character[]> {
    const response = await this.client.listCharacters(novelId);
    return response.characters;
  }

  async listCharacterRelations(novelId: string): Promise<CharacterRelation[]> {
    const response = await this.client.listCharacterGraph(novelId);
    return response.graph.relations;
  }

  async saveCharacters(novelId: string, characters: Character[], options?: ResourceMutationOptions): Promise<void> {
    await runResourceMutation('character_graph', options, () =>
      options
        ? this.client.saveCharacters(novelId, characters, options)
        : this.client.saveCharacters(novelId, characters),
    );
  }

  async saveCharacterGraph(
    novelId: string,
    graph: { characters: Character[]; relations: CharacterRelation[] },
    options?: ResourceMutationOptions,
  ): Promise<void> {
    const requestGraph = { novelId, characters: graph.characters, relations: graph.relations };
    await runResourceMutation('character_graph', options, () =>
      options
        ? this.client.saveCharacterGraph(novelId, requestGraph, options)
        : this.client.saveCharacterGraph(novelId, requestGraph),
    );
  }

  async getCharacterGraphKnowledgeV2(novelId: string) {
    return (await this.client.getCharacterGraphKnowledgeV2(novelId)).knowledge;
  }

  async saveCharacterGraphObservationsV2(
    observations: import('../providers/character-graph-v2').CharacterGraphKnowledgeV2,
  ): Promise<void> {
    await this.client.saveCharacterGraphObservationsV2(observations.novelId, observations);
  }

  async applyCharacterIdentityCommandV2(command: import('../providers/character-graph-v2').CharacterIdentityCommandV2) {
    return (await this.client.applyCharacterIdentityCommandV2(command.novelId, command)).result;
  }

  async listVoiceProfiles(novelId: string): Promise<VoiceProfile[]> {
    const response = await this.client.listVoiceProfiles(novelId);
    return response.voiceProfiles;
  }

  async saveVoiceProfiles(
    novelId: string,
    voiceProfiles: VoiceProfile[],
    options?: ResourceMutationOptions,
  ): Promise<void> {
    await runResourceMutation('voice_profiles', options, () =>
      options
        ? this.client.saveVoiceProfiles(novelId, voiceProfiles, options)
        : this.client.saveVoiceProfiles(novelId, voiceProfiles),
    );
  }

  async getVoiceProductState(novelId: string) {
    return (await this.client.getVoiceProductState(novelId)).state;
  }

  async saveVoiceProductState(
    novelId: string,
    state: import('../providers/voice-product').VoiceProductStateV1,
  ): Promise<void> {
    await this.client.saveVoiceProductState(novelId, state);
  }

  async getVoiceCastingWorkspace(novelId: string) {
    const aggregate = await this.client.getVoiceCastingState(novelId);
    if (!aggregate.state || !aggregate.userArtifacts || !aggregate.derivedArtifacts) return undefined;
    const source = await this.client.listVoiceCastingSource(novelId);
    return normalizeVoiceCastingWorkspace({
      bookId: novelId,
      contentRevisionId: aggregate.state.contentRevisionId,
      storageRevision: aggregate.revision,
      userArtifacts: aggregate.userArtifacts,
      derivedArtifacts: {
        utterances: source.utterances,
        importanceProfiles: aggregate.derivedArtifacts.importanceProfiles,
        traitEvidence: aggregate.derivedArtifacts.traitEvidence,
        traitProfiles: aggregate.derivedArtifacts.traitProfiles,
        pools: aggregate.derivedArtifacts.pools,
        state: aggregate.state,
      },
      status: aggregate.state.status === 'stale' ? 'stale' : 'active',
    });
  }

  async saveVoiceCastingWorkspace(input: {
    readonly workspace: import('../providers/voice-casting').VoiceCastingWorkspaceV1;
    readonly expectedStorageRevision: number;
  }): Promise<void> {
    const { utterances: _utterances, state, ...derivedArtifacts } = input.workspace.derivedArtifacts;
    const saved = await this.client.saveVoiceCastingState({
      bookId: input.workspace.bookId,
      expectedRevision: input.expectedStorageRevision,
      state,
      userArtifacts: input.workspace.userArtifacts,
      derivedArtifacts,
    });
    if (saved.revision !== input.workspace.storageRevision) {
      throw new RemoteMutationProtocolError('voice_casting_revision');
    }
  }

  async listAcceptedSpeakerUtterances(input: {
    readonly bookId: string;
    readonly contentRevisionId: string;
    readonly chapterId?: string;
  }) {
    const source = await this.client.listVoiceCastingSource(input.bookId);
    return source.utterances.filter(
      (utterance) =>
        utterance.contentRevisionId === input.contentRevisionId &&
        (input.chapterId === undefined || utterance.chapterId === input.chapterId),
    );
  }

  async listCorrections(novelId: string, chapterId?: string): Promise<UserCorrection[]> {
    const response = await this.client.listCorrections(novelId, { chapterId });
    return response.corrections;
  }

  async saveCorrection(correction: UserCorrection, options?: ResourceMutationOptions): Promise<void> {
    await runResourceMutation('user_correction', options, () =>
      options ? this.client.saveCorrection(correction, options) : this.client.saveCorrection(correction),
    );
  }

  async deleteCorrection(novelId: string, id: string, options?: ResourceMutationOptions): Promise<void> {
    await runResourceMutation('user_correction', options, () =>
      options ? this.client.deleteCorrection(novelId, id, options) : this.client.deleteCorrection(novelId, id),
    );
  }

  applyLabelCorrections(command: ApplyLabelCorrectionsCommandV2): Promise<ApplyLabelCorrectionsResultV2> {
    return this.client.applyLabelCorrections(command);
  }

  listSyncOutbox(_status?: SyncOutboxItem['status']): Promise<SyncOutboxItem[]> {
    return Promise.resolve([]);
  }

  getSyncState(): Promise<SyncState> {
    const now = new Date().toISOString();
    return Promise.resolve({
      id: 'sync-state',
      mode: 'connected',
      status: 'idle',
      pendingCount: 0,
      nextSequence: 1,
      updatedAt: now,
    });
  }
}
