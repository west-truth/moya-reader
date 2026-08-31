import type {
  Bookmark,
  Character,
  Chapter,
  LabeledSegment,
  ListeningPosition,
  Novel,
  Paragraph,
  ParagraphPage,
  ParsedNovel,
  ParsedNovelImport,
  ParsedNovelImportAsset,
  ParsedNovelImportChapter,
  ParsedNovelImportChapterSource,
  ReaderHighlight,
  ReaderNote,
  ReaderSettings,
  Shelf,
  ShelfMembership,
  UserCorrection,
  VoiceProfile,
  DocumentAnchor,
  DocumentAnnotation,
  DocumentTextOrderOverride,
  TextQuad,
} from '../domain/types';
import { integrityHash, persistentIdVersion } from '../domain/id-hash-contract';
import { paragraphPageId } from '../domain/parser/entity-identities';
import type { CharacterRelation } from '../providers/ai';
import type {
  JsonValue,
  ReadingPosition,
  RemoteBookSnapshot,
  RemoteBookSnapshotStream,
  SyncEvent,
} from '../sync/types';
import { defaultSettings, PARAGRAPHS_PER_PAGE } from '../repositories/reader-defaults';
import {
  type BookContentRevisionSource,
  type BookContentRevisionRecord,
  type ContentRevisionExpectedCounts,
  type ContentRevisionValidationState,
  contentRevisionComponentIds,
  createContentRevisionValidationState,
  finalizeContentRevisionValidation,
  logicalContentRevisionCounts,
  type StoredContentRevisionCounts,
  validateContentRevisionPageBatch,
} from './content-revisions';
import {
  activateStagedContentRevision as activateStoredContentRevision,
  type ContentActivationReaderPlan,
  chapterFromRevisionRow,
  cleanupStagingContentRevision as cleanupStoredContentRevision,
  createStagingContentRevision as createStoredContentRevision,
  type RevisionChapterRow,
  saveStagedContentChapters as saveStoredContentChapters,
  saveStagedContentPageBatch as saveStoredContentPageBatch,
  storedChapter,
  storedNovel,
} from './content-revision-store';
import {
  type ActiveContentRevisionDiagnostics,
  type BookContentRevisionHandle,
  getActiveContentRevisionDiagnostics as readActiveContentRevisionDiagnostics,
  openBookContentRevision as openStoredBookContentRevision,
} from './content-revision-read-handle';
import {
  addParagraphPagesToChildIdIndex,
  bookProgressFromChapterProgress,
  type BookChildIdIndex,
  createBookChildIdIndex,
} from './content-revision-remote-state';
import { buildCachedBookChildIdIndex, prepareContentActivationReaderPlan } from './content-activation-reader-plan';
import { CONTENT_REVISION_STORES } from './content-revision-migration';
import { deleteByIndexInTransaction, requestToPromise, transactionDone } from './indexeddb-transaction';
import type { SaveImportedNovelOptions, SaveImportedNovelProgress } from './import-progress';
import { throwIfImportCancelled, withImportProgressHeartbeat } from './import-progress';
import { openReaderDb, resetReaderDbForTests } from './reader-database';
import {
  getChapter,
  getChapters,
  getNovel,
  getNovels,
  getParagraph,
  getParagraphPage,
  getParagraphPages,
  getParagraphs,
  searchBookParagraphs,
  searchParagraphs,
} from './reader-query-store';
import {
  addNovelReadingTime,
  clearReadingPosition,
  getReadingPosition,
  getSettings,
  patchNovelMetadata,
  saveSettings,
  saveReadingPosition,
} from './reader-state-store';
import {
  deleteBookmark,
  deleteHighlight,
  deleteNote,
  getBookmarks,
  getHighlights,
  getNotes,
  saveBookmark,
  saveHighlight,
  saveNote,
} from './annotation-store';
import {
  deleteCorrection,
  getCharacterRelations,
  getCharacters,
  getCorrections,
  getSegments,
  getVoiceProfiles,
  saveCharacterGraph,
  saveCharacters,
  saveCorrection,
  saveSegments,
  saveVoiceProfiles,
} from './analysis-artifact-store';
import { providerOptionsContainSecretLikeValue } from './provider-options-secret-guard';
import { applyBookMetadataSyncEvent } from './book-metadata-sync';
import { BOOK_DATA_STORES, deleteBookDataInTransaction } from './book-data-cleanup';
import {
  cleanupStagedBookAsset,
  deleteBookAssetsInTransaction,
  stageEmbeddedBookAssets,
  stageOriginalSourceAsset,
} from './book-asset-store';
import { BOOK_ASSET_STORES } from './book-asset-schema';
import { moveNovelToTrash } from './library-catalog-store';
import { LIBRARY_MANAGEMENT_STORES } from './library-management-schema';
import { DOCUMENT_LISTENING_STORES } from './document-listening-schema';
import {
  clearListeningPosition,
  getListeningPosition,
  remapListeningPosition,
  saveListeningPosition,
} from './listening-position-store';
import {
  discardSyncOutboxItems,
  enqueueSyncEvent,
  getSyncState,
  jsonValue,
  listSyncOutbox,
  queueSyncEventInTransaction,
  saveSyncState,
  type SyncTombstone,
  tombstoneEntity,
  tombstoneId,
  updateSyncOutboxItems,
} from './sync-event-store';

export type { ActiveContentRevisionDiagnostics, BookContentRevisionHandle } from './content-revision-read-handle';
export { defaultSettings, PARAGRAPHS_PER_PAGE };
export { openReaderDb, resetReaderDbForTests };
export * from './id-v2-migration/public';
export {
  getChapter,
  getChapters,
  getNovel,
  getNovels,
  getParagraph,
  getParagraphPage,
  getParagraphPages,
  getParagraphs,
  searchBookParagraphs,
  searchParagraphs,
};
export {
  addNovelReadingTime,
  clearReadingPosition,
  getReadingPosition,
  getSettings,
  patchNovelMetadata,
  saveSettings,
  saveReadingPosition,
};
export { clearListeningPosition, getListeningPosition, remapListeningPosition, saveListeningPosition };
export {
  deleteBookmark,
  deleteHighlight,
  deleteNote,
  getBookmarks,
  getHighlights,
  getNotes,
  saveBookmark,
  saveHighlight,
  saveNote,
};
export {
  deleteCorrection,
  getCharacterRelations,
  getCharacters,
  getCorrections,
  getSegments,
  getVoiceProfiles,
  saveCharacterGraph,
  saveCharacters,
  saveCorrection,
  saveSegments,
  saveVoiceProfiles,
};
export { discardSyncOutboxItems, enqueueSyncEvent, getSyncState, listSyncOutbox, saveSyncState, updateSyncOutboxItems };
const IMPORT_PAGE_BATCH_SIZE = 10;
const IMPORT_CHAPTER_BATCH_SIZE = 200;

function recordValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {};
}

function stringField(value: JsonValue | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function stringArrayField(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function numberField(value: JsonValue | undefined, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanField(value: JsonValue | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isRemoteNewer(remoteUpdatedAt: string, localUpdatedAt?: string): boolean {
  return !localUpdatedAt || remoteUpdatedAt >= localUpdatedAt;
}

function chunked<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += safeSize) {
    chunks.push(items.slice(start, start + safeSize));
  }
  return chunks;
}

function groupParagraphsByChapter(paragraphs: Paragraph[]): Map<string, Paragraph[]> {
  const paragraphsByChapter = new Map<string, Paragraph[]>();
  for (const paragraph of paragraphs) {
    const group = paragraphsByChapter.get(paragraph.chapterId) ?? [];
    group.push(paragraph);
    paragraphsByChapter.set(paragraph.chapterId, group);
  }
  for (const group of paragraphsByChapter.values()) {
    group.sort((a, b) => a.index - b.index);
  }
  return paragraphsByChapter;
}

function countParagraphPages(chapters: Chapter[]): number {
  return chapters.reduce((total, chapter) => {
    return total + Math.ceil(chapter.paragraphCount / PARAGRAPHS_PER_PAGE);
  }, 0);
}

const MAX_APPEND_DELTA_COMPONENTS = 12;

interface AppendDeltaImportPlan {
  readonly baseRevision: BookContentRevisionRecord;
  readonly chapters: Chapter[];
  readonly logicalCounts: StoredContentRevisionCounts;
}

function documentFormatFamily(novel: Novel): 'text' | 'epub' | undefined {
  if (novel.format === 'epub') return 'epub';
  if (!novel.format || novel.format === 'txt' || novel.format === 'markdown') return 'text';
  return undefined;
}

async function getContentRevisionRecord(contentRevisionId: string): Promise<BookContentRevisionRecord | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(CONTENT_REVISION_STORES.revisions, 'readonly');
  const record = await requestToPromise<BookContentRevisionRecord | undefined>(
    tx.objectStore(CONTENT_REVISION_STORES.revisions).get(contentRevisionId),
  );
  await transactionDone(tx);
  return record;
}

async function planAppendDeltaImport(
  novel: Novel,
  chapters: Chapter[],
  options: SaveImportedNovelOptions,
): Promise<AppendDeltaImportPlan | undefined> {
  if (!options.allowAppendDelta) return undefined;
  const incomingFormatFamily = documentFormatFamily(novel);
  // EPUB chapters carry images, inline semantics and source locators that are
  // not represented by Chapter.textHash. Until those fields have a persisted
  // structural fingerprint, keep EPUB replacement on the safe full-write path.
  if (incomingFormatFamily !== 'text') return undefined;
  const currentNovel = await getNovel(novel.id);
  if (!currentNovel?.activeContentRevisionId || documentFormatFamily(currentNovel) !== incomingFormatFamily) {
    return undefined;
  }
  // Legacy v1 books can still enter the one-time ID migration, whose current
  // copy plan expects a single physical revision. Let their next import compact
  // to one full revision before considering append deltas.
  if (persistentIdVersion(currentNovel.id) === 'v1-fnv32') return undefined;
  const baseRevision = await getContentRevisionRecord(currentNovel.activeContentRevisionId);
  if (!baseRevision || baseRevision.status !== 'active') return undefined;
  const baseComponents = contentRevisionComponentIds(baseRevision);
  if (baseComponents.length >= MAX_APPEND_DELTA_COMPONENTS) return undefined;

  const handle = await openStoredBookContentRevision(await openReaderDb(), novel.id);
  const currentChapters = await handle.listChapters();
  if (chapters.length <= currentChapters.length) return undefined;
  const unchangedPrefix = currentChapters.every((current, offset) => {
    const incoming = chapters[offset];
    return (
      incoming?.index === current.index &&
      incoming.id === current.id &&
      incoming.title === current.title &&
      incoming.textHash.toLocaleLowerCase() === current.textHash.toLocaleLowerCase() &&
      incoming.paragraphCount === current.paragraphCount &&
      incoming.characterCount === current.characterCount
    );
  });
  if (!unchangedPrefix) return undefined;

  const deltaChapters = chapters.slice(currentChapters.length);
  if (deltaChapters.some((chapter, offset) => chapter.index !== currentChapters.length + offset + 1)) {
    return undefined;
  }
  const baseCounts = logicalContentRevisionCounts(baseRevision);
  if (!baseCounts) return undefined;
  const currentParagraphCount = currentChapters.reduce((total, chapter) => total + chapter.paragraphCount, 0);
  const deltaParagraphCount = deltaChapters.reduce((total, chapter) => total + chapter.paragraphCount, 0);
  if (
    baseCounts.chapterCount !== currentChapters.length ||
    baseCounts.paragraphCount !== currentParagraphCount ||
    novel.totalChapters !== chapters.length ||
    novel.totalParagraphs !== currentParagraphCount + deltaParagraphCount
  ) {
    return undefined;
  }
  return {
    baseRevision,
    chapters: deltaChapters,
    logicalCounts: {
      chapterCount: chapters.length,
      pageCount: baseCounts.pageCount + countParagraphPages(deltaChapters),
      paragraphCount: novel.totalParagraphs,
      paragraphRefCount: novel.totalParagraphs,
      searchRowCount: novel.totalParagraphs,
    },
  };
}

async function* selectChapterParagraphs(
  source: ParsedNovelImportChapterSource,
  chapterIds: ReadonlySet<string>,
): AsyncGenerator<ParsedNovelImportChapter> {
  for await (const chapterParagraphs of source) {
    if (chapterIds.has(chapterParagraphs.chapter.id)) yield chapterParagraphs;
  }
}

function* iterateParsedNovelChapters(
  chapters: Chapter[],
  paragraphsByChapter: Map<string, Paragraph[]>,
): Generator<ParsedNovelImportChapter> {
  for (const chapter of chapters) {
    yield {
      chapter,
      paragraphs: paragraphsByChapter.get(chapter.id) ?? [],
    };
  }
}

function createParagraphPage(chapter: Chapter, pageIndex: number, paragraphs: Paragraph[]): ParagraphPage {
  const orderedParagraphs = [...paragraphs].sort((a, b) => a.index - b.index);
  return {
    id: paragraphPageId(chapter.novelId, chapter.id, pageIndex),
    novelId: chapter.novelId,
    chapterId: chapter.id,
    pageIndex,
    startParagraphIndex: orderedParagraphs[0]?.index ?? 0,
    endParagraphIndex: orderedParagraphs[orderedParagraphs.length - 1]?.index ?? 0,
    paragraphs: orderedParagraphs,
    textHash: integrityHash(JSON.stringify(orderedParagraphs.map((paragraph) => paragraph.textHash))),
  };
}

function* iterateChapterParagraphPages({ chapter, paragraphs }: ParsedNovelImportChapter): Generator<ParagraphPage> {
  let pageIndex = 0;
  let pageParagraphs: Paragraph[] = [];
  for (const paragraph of paragraphs) {
    pageParagraphs.push(paragraph);
    if (pageParagraphs.length >= PARAGRAPHS_PER_PAGE) {
      yield createParagraphPage(chapter, pageIndex, pageParagraphs);
      pageIndex += 1;
      pageParagraphs = [];
    }
  }
  if (pageParagraphs.length) yield createParagraphPage(chapter, pageIndex, pageParagraphs);
}

export async function openBookContentRevision(novelId: string): Promise<BookContentRevisionHandle> {
  return openStoredBookContentRevision(await openReaderDb(), novelId);
}

export async function getActiveContentRevisionDiagnostics(novelId: string): Promise<ActiveContentRevisionDiagnostics> {
  return readActiveContentRevisionDiagnostics(await openReaderDb(), novelId);
}

async function createStagingContentRevision(input: {
  novel: Novel;
  source: BookContentRevisionSource;
  sourceRevision?: string;
  sourceHash?: string;
  expected: ContentRevisionExpectedCounts;
  expectedBaseActiveContentRevisionId?: string;
  appendDelta?: {
    baseRevision: BookContentRevisionRecord;
    logicalCounts: StoredContentRevisionCounts;
  };
}): Promise<BookContentRevisionRecord> {
  return createStoredContentRevision(await openReaderDb(), input);
}

async function saveStagedContentChapters(
  contentRevisionId: string,
  chapters: Chapter[],
  options: SaveImportedNovelOptions,
): Promise<number> {
  return saveStoredContentChapters(await openReaderDb(), contentRevisionId, chapters, {
    batchSize: IMPORT_CHAPTER_BATCH_SIZE,
    throwIfCancelled: () => throwIfImportCancelled(options),
  });
}

async function saveStagedContentPageBatch(contentRevisionId: string, pages: ParagraphPage[]): Promise<void> {
  return saveStoredContentPageBatch(await openReaderDb(), contentRevisionId, pages);
}

async function cleanupStagingContentRevision(contentRevisionId: string): Promise<void> {
  return cleanupStoredContentRevision(await openReaderDb(), contentRevisionId);
}

async function activateStagedContentRevision(input: {
  revision: BookContentRevisionRecord;
  actual: StoredContentRevisionCounts;
  novel: Novel;
  emitBookImported: boolean;
  readerPlan?: ContentActivationReaderPlan;
  shouldCancel?: () => boolean;
  sourceAssetId?: string;
  embeddedAssetIds?: readonly string[];
  embeddedAssetPageIndexes?: Readonly<Record<string, number>>;
  preserveExistingEmbeddedAssets?: boolean;
  preserveExistingCover?: boolean;
}): Promise<void> {
  return activateStoredContentRevision(await openReaderDb(), {
    revision: input.revision,
    actual: input.actual,
    novel: input.novel,
    readerPlan: input.readerPlan,
    shouldCancel: input.shouldCancel,
    sourceAssetId: input.sourceAssetId,
    embeddedAssetIds: input.embeddedAssetIds,
    embeddedAssetPageIndexes: input.embeddedAssetPageIndexes,
    preserveExistingEmbeddedAssets: input.preserveExistingEmbeddedAssets,
    preserveExistingCover: input.preserveExistingCover,
    queueBookImported: input.emitBookImported
      ? async (tx, novel) => {
          await queueSyncEventInTransaction(tx, 'book_imported', jsonValue({ novel }), {
            novelId: novel.id,
            entityId: novel.id,
          });
        }
      : undefined,
  });
}

function deleteEventTimestamp(event: SyncEvent): string {
  const payload = recordValue(event.payload);
  return stringField(payload.deletedAt, event.createdAt);
}

function jsonFromString(value: string | undefined): JsonValue | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return undefined;
  }
}

function remoteReadingPosition(event: SyncEvent): ReadingPosition | undefined {
  const payload = recordValue(event.payload);
  const position = recordValue(payload.position);
  const novelId = event.novelId || stringField(position.novelId) || stringField(position.bookId);
  const chapterId = stringField(position.chapterId);
  if (!novelId || !chapterId) return undefined;

  return {
    id: `reading_position_${novelId}`,
    novelId,
    chapterId,
    paragraphId: stringField(position.paragraphId) || undefined,
    paragraphIndex: numberField(position.paragraphIndex),
    offsetInParagraph: numberField(position.offsetInParagraph),
    chapterProgress: Math.max(0, Math.min(1, numberField(position.chapterProgress))),
    scrollTop: Math.max(0, Math.round(numberField(position.scrollTop))),
    deviceId: stringField(position.deviceId, event.deviceId),
    updatedAt: stringField(position.updatedAt, event.createdAt),
  };
}

function remoteTextQuads(value: JsonValue | undefined): TextQuad[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const quads: TextQuad[] = [];
  for (const item of value) {
    const quad = recordValue(item);
    const x = numberField(quad.x, Number.NaN);
    const y = numberField(quad.y, Number.NaN);
    const width = numberField(quad.width, Number.NaN);
    const height = numberField(quad.height, Number.NaN);
    if (
      ![x, y, width, height].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      width < 0 ||
      height < 0 ||
      x + width > 1.001 ||
      y + height > 1.001
    ) {
      return undefined;
    }
    quads.push({ x, y, width, height });
  }
  return quads;
}

function remoteDocumentAnchor(value: JsonValue | undefined, bookId: string): DocumentAnchor | undefined {
  const anchor = recordValue(value);
  const kind = stringField(anchor.kind);
  const pageIndex = numberField(anchor.pageIndex, Number.NaN);
  if (kind === 'fixed_page') {
    const pageHash = stringField(anchor.pageHash);
    if (!pageHash || !Number.isInteger(pageIndex) || pageIndex < 0) return undefined;
    return {
      kind,
      bookId: stringField(anchor.bookId, bookId),
      pageIndex,
      pageHash,
    };
  }
  if (kind === 'fixed_text') {
    const textRevisionId = stringField(anchor.textRevisionId);
    const blockId = stringField(anchor.blockId);
    if (!textRevisionId || !blockId || !Number.isInteger(pageIndex) || pageIndex < 0) return undefined;
    const startOffset = numberField(anchor.startOffset, Number.NaN);
    const endOffset = numberField(anchor.endOffset, Number.NaN);
    if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || startOffset < 0 || startOffset > endOffset) {
      return undefined;
    }
    const quads = remoteTextQuads(anchor.quads);
    if (anchor.quads !== undefined && !quads) return undefined;
    const blockRanges = Array.isArray(anchor.blockRanges)
      ? anchor.blockRanges.flatMap((item) => {
          const range = recordValue(item);
          const rangeBlockId = stringField(range.blockId);
          const rangeStart = numberField(range.startOffset, Number.NaN);
          const rangeEnd = numberField(range.endOffset, Number.NaN);
          return rangeBlockId && Number.isInteger(rangeStart) && Number.isInteger(rangeEnd) && rangeStart <= rangeEnd
            ? [{ blockId: rangeBlockId, startOffset: rangeStart, endOffset: rangeEnd }]
            : [];
        })
      : undefined;
    if (Array.isArray(anchor.blockRanges) && blockRanges?.length !== anchor.blockRanges.length) return undefined;
    return {
      kind,
      bookId: stringField(anchor.bookId, bookId),
      pageIndex,
      textRevisionId,
      blockId,
      startOffset,
      endOffset,
      blockRanges,
      quads,
    };
  }
  if (kind === 'fixed_region') {
    const pageHash = stringField(anchor.pageHash);
    const quads = remoteTextQuads(anchor.quads);
    if (!pageHash || !Number.isInteger(pageIndex) || pageIndex < 0 || !quads?.length) return undefined;
    return {
      kind,
      bookId: stringField(anchor.bookId, bookId),
      pageIndex,
      pageHash,
      quads,
    };
  }
  if (kind !== 'reflowable_text') return undefined;
  const reader = recordValue(anchor.reader);
  const paragraphId = stringField(anchor.paragraphId);
  const contentRevisionId = stringField(reader.contentRevisionId);
  const sectionId = stringField(reader.sectionId);
  const blockId = stringField(reader.blockId);
  if (!paragraphId || !contentRevisionId || !sectionId || !blockId) return undefined;
  const startOffset = Math.max(0, Math.floor(numberField(anchor.startOffset)));
  return {
    kind,
    paragraphId,
    startOffset,
    endOffset: Math.max(startOffset, Math.floor(numberField(anchor.endOffset, startOffset))),
    reader: {
      bookId: stringField(reader.bookId, bookId),
      contentRevisionId,
      sectionId,
      blockId,
      blockIndex: Number.isFinite(Number(reader.blockIndex)) ? Math.floor(numberField(reader.blockIndex)) : undefined,
      offset: Math.max(0, Math.floor(numberField(reader.offset, startOffset))),
    },
  };
}

function remoteListeningPosition(event: SyncEvent): ListeningPosition | undefined {
  const value = recordValue(recordValue(event.payload).listeningPosition);
  const bookId = event.novelId || stringField(value.bookId);
  const chapterId = stringField(value.chapterId);
  const contentRevisionId = stringField(value.contentRevisionId);
  const queueItemFingerprint = stringField(value.queueItemFingerprint);
  const settingsFingerprint = stringField(value.settingsFingerprint);
  if (!bookId || !chapterId || !contentRevisionId || !queueItemFingerprint || !settingsFingerprint) return undefined;
  const anchor = remoteDocumentAnchor(value.anchor, bookId);
  if (!anchor) return undefined;
  return {
    id: `listening_position_${bookId}`,
    bookId,
    chapterId,
    anchor,
    queueItemFingerprint,
    contentRevisionId,
    settingsFingerprint,
    deviceId: stringField(value.deviceId, event.deviceId),
    updatedAt: stringField(value.updatedAt, event.createdAt),
  };
}

function remoteBookmark(event: SyncEvent): Bookmark | undefined {
  const bookmark = recordValue(recordValue(event.payload).bookmark);
  const id = stringField(bookmark.id) || event.entityId;
  const novelId = stringField(bookmark.novelId) || stringField(bookmark.bookId) || event.novelId;
  const chapterId = stringField(bookmark.chapterId);
  if (!id || !novelId || !chapterId) return undefined;
  return {
    id,
    novelId,
    chapterId,
    paragraphId: stringField(bookmark.paragraphId) || undefined,
    label: stringField(bookmark.label),
    progress: numberField(bookmark.progress),
    scrollTop: numberField(bookmark.scrollTop),
    createdAt: stringField(bookmark.createdAt, event.createdAt),
  };
}

function remoteHighlight(event: SyncEvent): ReaderHighlight | undefined {
  const highlight = recordValue(recordValue(event.payload).highlight);
  const id = stringField(highlight.id) || event.entityId;
  const novelId = stringField(highlight.novelId) || stringField(highlight.bookId) || event.novelId;
  const chapterId = stringField(highlight.chapterId);
  const paragraphId = stringField(highlight.paragraphId);
  if (!id || !novelId || !chapterId || !paragraphId) return undefined;
  const color = stringField(highlight.color, 'yellow') as ReaderHighlight['color'];
  return {
    id,
    novelId,
    chapterId,
    paragraphId,
    quote: stringField(highlight.quote),
    color: ['yellow', 'green', 'blue', 'pink'].includes(color) ? color : 'yellow',
    progress: numberField(highlight.progress),
    createdAt: stringField(highlight.createdAt, event.createdAt),
    updatedAt: stringField(highlight.updatedAt, event.createdAt),
  };
}

function remoteNote(event: SyncEvent): ReaderNote | undefined {
  const note = recordValue(recordValue(event.payload).note);
  const id = stringField(note.id) || event.entityId;
  const novelId = stringField(note.novelId) || stringField(note.bookId) || event.novelId;
  const chapterId = stringField(note.chapterId);
  if (!id || !novelId || !chapterId) return undefined;
  return {
    id,
    novelId,
    chapterId,
    paragraphId: stringField(note.paragraphId) || undefined,
    quote: stringField(note.quote) || undefined,
    body: stringField(note.body),
    progress: numberField(note.progress),
    createdAt: stringField(note.createdAt, event.createdAt),
    updatedAt: stringField(note.updatedAt, event.createdAt),
  };
}

function remoteDocumentAnnotation(event: SyncEvent): DocumentAnnotation | undefined {
  const value = recordValue(recordValue(event.payload).annotation);
  const id = stringField(value.id) || event.entityId;
  const bookId = event.novelId || stringField(value.bookId);
  const pageIndex = numberField(value.pageIndex, Number.NaN);
  const type = stringField(value.type) as DocumentAnnotation['type'];
  if (
    !id ||
    !bookId ||
    !Number.isInteger(pageIndex) ||
    pageIndex < 0 ||
    !['page_bookmark', 'text_highlight', 'text_note', 'region_highlight', 'region_note'].includes(type)
  ) {
    return undefined;
  }
  const anchor = remoteDocumentAnchor(value.anchor, bookId);
  if (!anchor || anchor.kind === 'reflowable_text' || anchor.bookId !== bookId || anchor.pageIndex !== pageIndex) {
    return undefined;
  }
  const remapValue = recordValue(value.textAnchorRemap);
  const remapStatus = stringField(remapValue.status) as 'remapped' | 'needs_review';
  const textAnchorRemap = ['remapped', 'needs_review'].includes(remapStatus)
    ? {
        status: remapStatus,
        fromTextRevisionId: stringField(remapValue.fromTextRevisionId),
        targetTextRevisionId: stringField(remapValue.targetTextRevisionId),
        updatedAt: stringField(remapValue.updatedAt),
      }
    : undefined;
  if (
    textAnchorRemap &&
    (!textAnchorRemap.fromTextRevisionId || !textAnchorRemap.targetTextRevisionId || !textAnchorRemap.updatedAt)
  ) {
    return undefined;
  }
  return {
    id,
    bookId,
    pageIndex,
    type,
    anchor,
    quote: stringField(value.quote) || undefined,
    body: stringField(value.body) || undefined,
    color: stringField(value.color) || undefined,
    textAnchorRemap,
    createdAt: stringField(value.createdAt, event.createdAt),
    updatedAt: stringField(value.updatedAt, event.createdAt),
  };
}

function remoteDocumentTextOrderOverride(event: SyncEvent): DocumentTextOrderOverride | undefined {
  const value = recordValue(recordValue(event.payload).orderOverride);
  const id = stringField(value.id) || event.entityId;
  const bookId = event.novelId || stringField(value.bookId);
  const pageIndex = numberField(value.pageIndex, Number.NaN);
  const pageHash = stringField(value.pageHash);
  const sourceRevisionId = stringField(value.sourceRevisionId);
  const orderedBlockFingerprints = Array.isArray(value.orderedBlockFingerprints)
    ? value.orderedBlockFingerprints.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  const excludedBlockFingerprints = Array.isArray(value.excludedBlockFingerprints)
    ? value.excludedBlockFingerprints.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  if (
    !id ||
    !bookId ||
    !Number.isInteger(pageIndex) ||
    pageIndex < 0 ||
    !pageHash ||
    !sourceRevisionId ||
    orderedBlockFingerprints.length !==
      (Array.isArray(value.orderedBlockFingerprints) ? value.orderedBlockFingerprints.length : -1) ||
    excludedBlockFingerprints.length !==
      (Array.isArray(value.excludedBlockFingerprints) ? value.excludedBlockFingerprints.length : -1)
  ) {
    return undefined;
  }
  return {
    id,
    bookId,
    pageIndex,
    pageHash,
    sourceRevisionId,
    orderedBlockFingerprints,
    excludedBlockFingerprints,
    createdAt: stringField(value.createdAt, event.createdAt),
    updatedAt: stringField(value.updatedAt, event.createdAt),
  };
}

function remoteVoiceProfiles(event: SyncEvent): VoiceProfile[] | undefined {
  const payload = recordValue(event.payload);
  const novelId = event.novelId || stringField(payload.novelId) || stringField(payload.bookId);
  if (!novelId || !Array.isArray(payload.voiceProfiles)) return undefined;
  const profiles: VoiceProfile[] = [];
  for (const value of payload.voiceProfiles) {
    const profile = recordValue(value);
    const id = stringField(profile.id);
    const role = stringField(profile.role) as VoiceProfile['role'];
    const providerId = stringField(profile.providerId);
    const providerVoiceId = stringField(profile.providerVoiceId);
    const label = stringField(profile.label);
    if (
      !id ||
      !['narrator', 'character', 'system', 'unknown'].includes(role) ||
      !providerId ||
      !providerVoiceId ||
      !label
    ) {
      return undefined;
    }
    const providerOptions = recordValue(profile.providerOptions);
    if (providerOptionsContainSecretLikeValue(providerOptions)) return undefined;
    profiles.push({
      id,
      novelId,
      characterId: stringField(profile.characterId) || undefined,
      role,
      providerId,
      providerVoiceId,
      providerModel: stringField(profile.providerModel) || undefined,
      label,
      language: stringField(profile.language) || undefined,
      tone: stringField(profile.tone) || undefined,
      speed: numberField(profile.speed, 1),
      pitch: profile.pitch === undefined ? undefined : numberField(profile.pitch),
      emotionPolicy: stringField(profile.emotionPolicy) || undefined,
      providerOptions,
      isUserSelected: booleanField(profile.isUserSelected) ?? false,
      createdAt: stringField(profile.createdAt, event.createdAt),
      updatedAt: stringField(profile.updatedAt, event.createdAt),
    });
  }
  return profiles;
}

function remoteCorrection(event: SyncEvent): UserCorrection | undefined {
  const correction = recordValue(recordValue(event.payload).correction);
  const id = stringField(correction.id) || event.entityId;
  const novelId = stringField(correction.novelId) || stringField(correction.bookId) || event.novelId;
  const chapterId = stringField(correction.chapterId);
  const correctionType = stringField(correction.correctionType) as UserCorrection['correctionType'];
  const afterJson = stringField(correction.afterJson);
  const applyScope = stringField(correction.applyScope) as UserCorrection['applyScope'];
  if (
    !id ||
    !novelId ||
    !chapterId ||
    !['speaker', 'listener', 'emotion', 'prosody', 'segment_type', 'voice', 'note'].includes(correctionType) ||
    !afterJson ||
    !['segment', 'chapter', 'future_pattern', 'global'].includes(applyScope)
  ) {
    return undefined;
  }
  return {
    id,
    novelId,
    chapterId,
    paragraphId: stringField(correction.paragraphId) || undefined,
    segmentId: stringField(correction.segmentId) || undefined,
    correctionType,
    beforeJson: stringField(correction.beforeJson) || undefined,
    afterJson,
    applyScope,
    createdAt: stringField(correction.createdAt, event.createdAt),
  };
}

const segmentTypes: LabeledSegment['type'][] = [
  'narration',
  'quoted_dialogue',
  'plain_dialogue',
  'inner_monologue',
  'system_message',
  'sfx',
  'author_note',
  'unknown',
];

function remoteCharacter(value: JsonValue | undefined, novelId: string): Character | undefined {
  const character = recordValue(value);
  const id = stringField(character.id);
  const canonicalName = stringField(character.canonicalName);
  const aliases = Array.isArray(character.aliases)
    ? character.aliases.filter((alias): alias is string => typeof alias === 'string')
    : undefined;
  const color = stringField(character.color);
  if (!id || !canonicalName || !aliases || !color) return undefined;
  return {
    id,
    novelId,
    canonicalName,
    aliases,
    color,
    description: stringField(character.description) || undefined,
    confidence: Math.max(0, Math.min(1, numberField(character.confidence))),
    isUserConfirmed: booleanField(character.isUserConfirmed) ?? false,
  };
}

function remoteCharacterRelation(
  value: JsonValue | undefined,
  novelId: string,
  characterIds: Set<string>,
): CharacterRelation | undefined {
  const relation = recordValue(value);
  const id = stringField(relation.id);
  const sourceCharacterId = stringField(relation.sourceCharacterId);
  const targetCharacterId = stringField(relation.targetCharacterId);
  const relationLabel = stringField(relation.relationLabel);
  const termsUsedBySource = Array.isArray(relation.termsUsedBySource)
    ? relation.termsUsedBySource.filter((term): term is string => typeof term === 'string')
    : undefined;
  const termsUsedByTarget = Array.isArray(relation.termsUsedByTarget)
    ? relation.termsUsedByTarget.filter((term): term is string => typeof term === 'string')
    : undefined;
  const evidence = Array.isArray(relation.evidence)
    ? relation.evidence.filter((item): item is string => typeof item === 'string')
    : undefined;
  if (
    !id ||
    !sourceCharacterId ||
    !targetCharacterId ||
    sourceCharacterId === targetCharacterId ||
    !characterIds.has(sourceCharacterId) ||
    !characterIds.has(targetCharacterId) ||
    !relationLabel ||
    !termsUsedBySource ||
    !termsUsedByTarget
  ) {
    return undefined;
  }
  return {
    id,
    novelId,
    sourceCharacterId,
    targetCharacterId,
    relationLabel,
    termsUsedBySource,
    termsUsedByTarget,
    confidence: Math.max(0, Math.min(1, numberField(relation.confidence))),
    evidence,
  };
}

function remoteCharacterGraph(
  event: SyncEvent,
):
  { novelId: string; mode: 'patch' | 'replace'; characters: Character[]; relations?: CharacterRelation[] } | undefined {
  const payload = recordValue(event.payload);
  const novelId = event.novelId || stringField(payload.novelId) || stringField(payload.bookId);
  const mode = stringField(payload.mode, 'patch') as 'patch' | 'replace';
  if (!novelId || !['patch', 'replace'].includes(mode) || !Array.isArray(payload.characters)) return undefined;
  const characters: Character[] = [];
  for (const value of payload.characters) {
    const character = remoteCharacter(value, novelId);
    if (!character) return undefined;
    characters.push(character);
  }
  const characterIds = new Set(characters.map((character) => character.id));
  let relations: CharacterRelation[] | undefined;
  if (Array.isArray(payload.relations)) {
    relations = [];
    for (const value of payload.relations) {
      const relation = remoteCharacterRelation(value, novelId, characterIds);
      if (!relation) return undefined;
      relations.push(relation);
    }
  }
  return { novelId, mode, characters, relations };
}

function remoteSegment(value: JsonValue | undefined, novelId: string, chapterId: string): LabeledSegment | undefined {
  const segment = recordValue(value);
  const id = stringField(segment.id);
  const paragraphId = stringField(segment.paragraphId);
  const segmentIndex = numberField(segment.segmentIndex, Number.NaN);
  const startOffset = numberField(segment.startOffset, Number.NaN);
  const endOffset = numberField(segment.endOffset, Number.NaN);
  const segmentTextHash = stringField(segment.segmentTextHash);
  const type = stringField(segment.type) as LabeledSegment['type'];
  const speakerId = stringField(segment.speakerId);
  const candidateSpeakers = Array.isArray(segment.candidateSpeakers)
    ? segment.candidateSpeakers.filter((speaker): speaker is string => typeof speaker === 'string')
    : undefined;
  const listenerIds = Array.isArray(segment.listenerIds)
    ? segment.listenerIds.filter((listener): listener is string => typeof listener === 'string')
    : undefined;
  const confidence = numberField(segment.confidence, Number.NaN);
  const segmentNovelId = stringField(segment.novelId) || novelId;
  const segmentChapterId = stringField(segment.chapterId) || chapterId;
  if (
    !id ||
    segmentNovelId !== novelId ||
    segmentChapterId !== chapterId ||
    !paragraphId ||
    !Number.isInteger(segmentIndex) ||
    segmentIndex < 0 ||
    !Number.isInteger(startOffset) ||
    !Number.isInteger(endOffset) ||
    startOffset >= endOffset ||
    !segmentTextHash ||
    !segmentTypes.includes(type) ||
    !speakerId ||
    !candidateSpeakers ||
    !listenerIds ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return undefined;
  }
  return {
    id,
    novelId,
    chapterId,
    paragraphId,
    segmentIndex,
    startOffset,
    endOffset,
    segmentTextHash,
    type,
    speakerId,
    candidateSpeakers,
    listenerIds,
    emotion: stringField(segment.emotion, 'neutral'),
    confidence,
    evidence: stringField(segment.evidence) || undefined,
    voiceProfileId: stringField(segment.voiceProfileId) || undefined,
    isUserCorrected: booleanField(segment.isUserCorrected) ?? false,
  };
}

function remoteChapterSegments(event: SyncEvent):
  | {
      novelId: string;
      chapterId: string;
      mode: 'patch' | 'replace';
      paragraphIds: string[];
      segments: LabeledSegment[];
    }
  | undefined {
  const payload = recordValue(event.payload);
  const novelId = event.novelId || stringField(payload.novelId) || stringField(payload.bookId);
  const chapterId = stringField(payload.chapterId) || event.entityId?.replace(/^chapter_segments_/, '') || '';
  const mode = stringField(payload.mode, 'replace') as 'patch' | 'replace';
  if (!novelId || !chapterId || !['patch', 'replace'].includes(mode) || !Array.isArray(payload.segments))
    return undefined;
  const segments: LabeledSegment[] = [];
  for (const value of payload.segments) {
    const segment = remoteSegment(value, novelId, chapterId);
    if (!segment) return undefined;
    segments.push(segment);
  }
  const segmentParagraphIds = [...new Set(segments.map((segment) => segment.paragraphId))];
  const payloadParagraphIds = stringArrayField(payload.paragraphIds);
  const paragraphIds =
    mode === 'patch' ? [...new Set(payloadParagraphIds.length ? payloadParagraphIds : segmentParagraphIds)] : [];
  if (mode === 'patch') {
    if (paragraphIds.length === 0) return undefined;
    const allowed = new Set(paragraphIds);
    if (segments.some((segment) => !allowed.has(segment.paragraphId))) return undefined;
  }
  return { novelId, chapterId, mode, paragraphIds, segments };
}

function mergeRemoteCharacter(existing: Character | undefined, incoming: Character): Character {
  if (!existing?.isUserConfirmed || incoming.isUserConfirmed) return incoming;
  return {
    ...existing,
    confidence: Math.max(existing.confidence, incoming.confidence),
    isUserConfirmed: true,
  };
}

async function applyRemoteSyncEvent(tx: IDBTransaction, event: SyncEvent): Promise<void> {
  if (event.type === 'listening_position_updated') {
    const position = remoteListeningPosition(event);
    if (!position) return;
    const store = tx.objectStore(DOCUMENT_LISTENING_STORES.listeningPositions);
    const tombstones = tx.objectStore('sync_tombstones');
    const [existing, tombstone] = await Promise.all([
      requestToPromise<ListeningPosition | undefined>(store.get(position.id)),
      requestToPromise<SyncTombstone | undefined>(tombstones.get(tombstoneId('listening_position', position.id))),
    ]);
    if (tombstone && !isRemoteNewer(position.updatedAt, tombstone.deletedAt)) return;
    if (existing && !isRemoteNewer(position.updatedAt, existing.updatedAt)) return;
    store.put(position);
    tombstones.delete(tombstoneId('listening_position', position.id));
    return;
  }

  if (event.type === 'listening_position_deleted' && event.novelId) {
    const payload = recordValue(event.payload);
    const id = stringField(payload.id) || event.entityId || `listening_position_${event.novelId}`;
    const deletedAt = deleteEventTimestamp(event);
    const store = tx.objectStore(DOCUMENT_LISTENING_STORES.listeningPositions);
    const tombstones = tx.objectStore('sync_tombstones');
    const [existing, tombstone] = await Promise.all([
      requestToPromise<ListeningPosition | undefined>(store.get(id)),
      requestToPromise<SyncTombstone | undefined>(tombstones.get(tombstoneId('listening_position', id))),
    ]);
    if (tombstone && !isRemoteNewer(deletedAt, tombstone.deletedAt)) return;
    if (existing && !isRemoteNewer(deletedAt, existing.updatedAt)) return;
    store.delete(id);
    tombstones.put(tombstoneEntity('listening_position', id, deletedAt, event.novelId));
    return;
  }

  if (event.type === 'reading_position_updated') {
    const position = remoteReadingPosition(event);
    if (!position) return;
    const positionStore = tx.objectStore('reading_positions');
    const novelStore = tx.objectStore('novels');
    const chapterStore = tx.objectStore('chapters');
    const tombstoneStore = tx.objectStore('sync_tombstones');
    const [existingPosition, existingNovel, legacyChapter, tombstone] = await Promise.all([
      requestToPromise<ReadingPosition | undefined>(positionStore.get(position.id)),
      requestToPromise<Novel | undefined>(novelStore.get(position.novelId)),
      requestToPromise<Chapter | undefined>(chapterStore.get(position.chapterId)),
      requestToPromise<SyncTombstone | undefined>(tombstoneStore.get(tombstoneId('reading_position', position.id))),
    ]);
    if (tombstone && !isRemoteNewer(position.updatedAt, tombstone.deletedAt)) return;
    if (existingPosition && !isRemoteNewer(position.updatedAt, existingPosition.updatedAt)) return;
    tombstoneStore.delete(tombstoneId('reading_position', position.id));
    positionStore.put(position);
    if (existingNovel) {
      const activeRevision = existingNovel.activeContentRevisionId
        ? await requestToPromise<BookContentRevisionRecord | undefined>(
            tx.objectStore(CONTENT_REVISION_STORES.revisions).get(existingNovel.activeContentRevisionId),
          )
        : undefined;
      const activeComponentIds = existingNovel.activeContentRevisionId
        ? activeRevision
          ? contentRevisionComponentIds(activeRevision)
          : [existingNovel.activeContentRevisionId]
        : [];
      const revisionChapter = (
        await Promise.all(
          [...activeComponentIds]
            .reverse()
            .map((contentRevisionId) =>
              requestToPromise<RevisionChapterRow | undefined>(
                tx
                  .objectStore(CONTENT_REVISION_STORES.chapters)
                  .index('contentRevisionId_domainId')
                  .get([contentRevisionId, position.chapterId]),
              ),
            ),
        )
      ).find(Boolean);
      const existingChapter = revisionChapter ? chapterFromRevisionRow(revisionChapter) : legacyChapter;
      novelStore.put({
        ...existingNovel,
        lastReadChapterId: position.chapterId,
        lastReadChapterIndex: existingChapter?.index,
        lastReadParagraphId: position.paragraphId,
        lastReadOffset: position.scrollTop,
        lastReadProgress: bookProgressFromChapterProgress(existingNovel, existingChapter, position.chapterProgress),
        updatedAt: isRemoteNewer(position.updatedAt, existingNovel.updatedAt)
          ? position.updatedAt
          : existingNovel.updatedAt,
      });
    }
    return;
  }

  if (event.type === 'reading_position_deleted' && event.novelId) {
    const payload = recordValue(event.payload);
    const id = stringField(payload.id) || event.entityId || `reading_position_${event.novelId}`;
    const deletedAt = deleteEventTimestamp(event);
    const positionStore = tx.objectStore('reading_positions');
    const tombstoneStore = tx.objectStore('sync_tombstones');
    const [existingPosition, existingNovel, tombstone] = await Promise.all([
      requestToPromise<ReadingPosition | undefined>(positionStore.get(id)),
      requestToPromise<Novel | undefined>(tx.objectStore('novels').get(event.novelId)),
      requestToPromise<SyncTombstone | undefined>(tombstoneStore.get(tombstoneId('reading_position', id))),
    ]);
    if (tombstone && !isRemoteNewer(deletedAt, tombstone.deletedAt)) return;
    if (existingPosition && !isRemoteNewer(deletedAt, existingPosition.updatedAt)) return;
    positionStore.delete(id);
    tombstoneStore.put(tombstoneEntity('reading_position', id, deletedAt, event.novelId));
    if (existingNovel) {
      tx.objectStore('novels').put(
        storedNovel({
          ...existingNovel,
          lastReadChapterId: undefined,
          lastReadChapterIndex: undefined,
          lastReadParagraphId: undefined,
          lastReadOffset: 0,
          lastReadProgress: 0,
          updatedAt: isRemoteNewer(deletedAt, existingNovel.updatedAt) ? deletedAt : existingNovel.updatedAt,
        }),
      );
    }
    return;
  }

  if (event.type === 'settings_updated') {
    const settings = {
      ...defaultSettings,
      ...recordValue(recordValue(event.payload).settings),
      id: defaultSettings.id,
    } as ReaderSettings;
    tx.objectStore('settings').put(settings);
    return;
  }

  if (event.type === 'book_updated' && event.novelId) {
    await applyBookMetadataSyncEvent(tx, event);
    return;
  }

  if (event.type === 'shelf_updated') {
    const payload = recordValue(event.payload);
    const value = recordValue(payload.shelf);
    const id = stringField(value.id) || event.entityId;
    const name = stringField(value.name);
    if (!id || !name) return;
    const store = tx.objectStore(LIBRARY_MANAGEMENT_STORES.shelves);
    const tombstones = tx.objectStore('sync_tombstones');
    const [existing, tombstone] = await Promise.all([
      requestToPromise<Shelf | undefined>(store.get(id)),
      requestToPromise<SyncTombstone | undefined>(tombstones.get(tombstoneId('shelf', id))),
    ]);
    if (tombstone && !isRemoteNewer(event.createdAt, tombstone.deletedAt)) return;
    const revision = numberField(value.revision);
    if (existing && revision < existing.revision) return;
    store.put({
      id,
      name,
      color: stringField(value.color) || undefined,
      sortOrder: numberField(value.sortOrder),
      createdAt: stringField(value.createdAt, existing?.createdAt ?? event.createdAt),
      updatedAt: stringField(value.updatedAt, event.createdAt),
      revision,
    } satisfies Shelf);
    tombstones.delete(tombstoneId('shelf', id));
    return;
  }

  if (event.type === 'shelf_deleted') {
    const payload = recordValue(event.payload);
    const id = stringField(payload.shelfId) || event.entityId;
    if (!id) return;
    const deletedAt = stringField(payload.deletedAt, event.createdAt);
    tx.objectStore(LIBRARY_MANAGEMENT_STORES.shelves).delete(id);
    const membershipStore = tx.objectStore(LIBRARY_MANAGEMENT_STORES.memberships);
    const keys = await requestToPromise<IDBValidKey[]>(membershipStore.index('shelfId').getAllKeys(id));
    keys.forEach((key) => membershipStore.delete(key));
    tx.objectStore('sync_tombstones').put(tombstoneEntity('shelf', id, deletedAt));
    return;
  }

  if (event.type === 'shelf_membership_added') {
    const value = recordValue(recordValue(event.payload).membership);
    const id = stringField(value.id) || event.entityId;
    const shelfId = stringField(value.shelfId);
    const bookId = stringField(value.bookId) || event.novelId;
    if (!id || !shelfId || !bookId) return;
    const tombstoneStore = tx.objectStore('sync_tombstones');
    const tombstone = await requestToPromise<SyncTombstone | undefined>(
      tombstoneStore.get(tombstoneId('shelf_membership', id)),
    );
    if (tombstone && !isRemoteNewer(event.createdAt, tombstone.deletedAt)) return;
    tx.objectStore(LIBRARY_MANAGEMENT_STORES.memberships).put({
      id,
      shelfId,
      bookId,
      createdAt: stringField(value.createdAt, event.createdAt),
    } satisfies ShelfMembership);
    tombstoneStore.delete(tombstoneId('shelf_membership', id));
    return;
  }

  if (event.type === 'shelf_membership_removed') {
    const payload = recordValue(event.payload);
    const id = stringField(payload.id) || event.entityId;
    if (!id) return;
    const deletedAt = stringField(payload.removedAt, event.createdAt);
    tx.objectStore(LIBRARY_MANAGEMENT_STORES.memberships).delete(id);
    tx.objectStore('sync_tombstones').put(
      tombstoneEntity('shelf_membership', id, deletedAt, stringField(payload.bookId) || event.novelId),
    );
    return;
  }

  if ((event.type === 'book_trashed' || event.type === 'book_restored') && event.novelId) {
    const store = tx.objectStore('novels');
    const current = await requestToPromise<Novel | undefined>(store.get(event.novelId));
    if (!current) return;
    const payload = recordValue(event.payload);
    const incomingRevision = numberField(payload.metadataRevision);
    if (incomingRevision < (current.metadataRevision ?? 0)) return;
    if (event.type === 'book_trashed') {
      const deletedAt = stringField(payload.deletedAt, event.createdAt);
      store.put({
        ...current,
        deletedAt,
        deletedByDeviceId: stringField(payload.deletedByDeviceId, event.deviceId),
        metadataRevision: incomingRevision,
        updatedAt: deletedAt,
      } satisfies Novel);
    } else {
      store.put({
        ...current,
        deletedAt: undefined,
        deletedByDeviceId: undefined,
        metadataRevision: incomingRevision,
        updatedAt: stringField(payload.restoredAt, event.createdAt),
      } satisfies Novel);
    }
    return;
  }

  if (event.type === 'book_purged' && event.novelId) {
    tx.objectStore('novels').delete(event.novelId);
    deleteBookDataInTransaction(tx, event.novelId);
    deleteBookAssetsInTransaction(tx, event.novelId);
    return;
  }

  if (event.type === 'book_deleted' && event.novelId) {
    const novelId = event.novelId;
    tx.objectStore('novels').delete(novelId);
    deleteBookDataInTransaction(tx, novelId);
    return;
  }

  if (event.type === 'bookmark_created') {
    const bookmark = remoteBookmark(event);
    if (!bookmark) return;
    const tombstoneStore = tx.objectStore('sync_tombstones');
    const tombstone = await requestToPromise<SyncTombstone | undefined>(
      tombstoneStore.get(tombstoneId('bookmark', bookmark.id)),
    );
    if (tombstone && !isRemoteNewer(bookmark.createdAt, tombstone.deletedAt)) return;
    tombstoneStore.delete(tombstoneId('bookmark', bookmark.id));
    tx.objectStore('bookmarks').put(bookmark);
    return;
  }

  if (event.type === 'bookmark_deleted') {
    const id = stringField(recordValue(event.payload).id) || event.entityId;
    if (!id) return;
    const deletedAt = deleteEventTimestamp(event);
    const store = tx.objectStore('bookmarks');
    const existing = await requestToPromise<Bookmark | undefined>(store.get(id));
    if (existing && !isRemoteNewer(deletedAt, existing.createdAt)) return;
    store.delete(id);
    tx.objectStore('sync_tombstones').put(
      tombstoneEntity('bookmark', id, deletedAt, existing?.novelId ?? event.novelId),
    );
    return;
  }

  if (event.type === 'highlight_created') {
    const highlight = remoteHighlight(event);
    if (!highlight) return;
    const store = tx.objectStore('highlights');
    const tombstoneStore = tx.objectStore('sync_tombstones');
    const [existing, tombstone] = await Promise.all([
      requestToPromise<ReaderHighlight | undefined>(store.get(highlight.id)),
      requestToPromise<SyncTombstone | undefined>(tombstoneStore.get(tombstoneId('highlight', highlight.id))),
    ]);
    if (tombstone && !isRemoteNewer(highlight.updatedAt, tombstone.deletedAt)) return;
    if (!existing || isRemoteNewer(highlight.updatedAt, existing.updatedAt)) store.put(highlight);
    tombstoneStore.delete(tombstoneId('highlight', highlight.id));
    return;
  }

  if (event.type === 'highlight_deleted') {
    const id = stringField(recordValue(event.payload).id) || event.entityId;
    if (!id) return;
    const deletedAt = deleteEventTimestamp(event);
    const store = tx.objectStore('highlights');
    const existing = await requestToPromise<ReaderHighlight | undefined>(store.get(id));
    if (existing && !isRemoteNewer(deletedAt, existing.updatedAt)) return;
    store.delete(id);
    tx.objectStore('sync_tombstones').put(
      tombstoneEntity('highlight', id, deletedAt, existing?.novelId ?? event.novelId),
    );
    return;
  }

  if (event.type === 'note_created' || event.type === 'note_updated') {
    const note = remoteNote(event);
    if (!note) return;
    const store = tx.objectStore('notes');
    const tombstoneStore = tx.objectStore('sync_tombstones');
    const [existing, tombstone] = await Promise.all([
      requestToPromise<ReaderNote | undefined>(store.get(note.id)),
      requestToPromise<SyncTombstone | undefined>(tombstoneStore.get(tombstoneId('note', note.id))),
    ]);
    if (tombstone && !isRemoteNewer(note.updatedAt, tombstone.deletedAt)) return;
    if (!existing || isRemoteNewer(note.updatedAt, existing.updatedAt)) store.put(note);
    tombstoneStore.delete(tombstoneId('note', note.id));
    return;
  }

  if (event.type === 'note_deleted') {
    const id = stringField(recordValue(event.payload).id) || event.entityId;
    if (!id) return;
    const deletedAt = deleteEventTimestamp(event);
    const store = tx.objectStore('notes');
    const existing = await requestToPromise<ReaderNote | undefined>(store.get(id));
    if (existing && !isRemoteNewer(deletedAt, existing.updatedAt)) return;
    store.delete(id);
    tx.objectStore('sync_tombstones').put(tombstoneEntity('note', id, deletedAt, existing?.novelId ?? event.novelId));
    return;
  }

  if (event.type === 'document_annotation_updated') {
    const annotation = remoteDocumentAnnotation(event);
    if (!annotation) return;
    const store = tx.objectStore(DOCUMENT_LISTENING_STORES.documentAnnotations);
    const tombstoneStore = tx.objectStore('sync_tombstones');
    const [existing, tombstone] = await Promise.all([
      requestToPromise<DocumentAnnotation | undefined>(store.get(annotation.id)),
      requestToPromise<SyncTombstone | undefined>(
        tombstoneStore.get(tombstoneId('document_annotation', annotation.id)),
      ),
    ]);
    if (tombstone && !isRemoteNewer(annotation.updatedAt, tombstone.deletedAt)) return;
    if (!existing || isRemoteNewer(annotation.updatedAt, existing.deletedAt ?? existing.updatedAt)) {
      store.put(annotation);
    }
    tombstoneStore.delete(tombstoneId('document_annotation', annotation.id));
    return;
  }

  if (event.type === 'document_annotation_deleted') {
    const payload = recordValue(event.payload);
    const id = stringField(payload.id) || event.entityId;
    if (!id) return;
    const deletedAt = deleteEventTimestamp(event);
    const store = tx.objectStore(DOCUMENT_LISTENING_STORES.documentAnnotations);
    const existing = await requestToPromise<DocumentAnnotation | undefined>(store.get(id));
    if (existing && !isRemoteNewer(deletedAt, existing.deletedAt ?? existing.updatedAt)) return;
    store.delete(id);
    tx.objectStore('sync_tombstones').put(
      tombstoneEntity('document_annotation', id, deletedAt, existing?.bookId ?? event.novelId),
    );
    return;
  }

  if (event.type === 'document_text_order_override_updated') {
    const override = remoteDocumentTextOrderOverride(event);
    if (!override) return;
    const store = tx.objectStore(DOCUMENT_LISTENING_STORES.documentTextOrderOverrides);
    const tombstoneStore = tx.objectStore('sync_tombstones');
    const [existing, tombstone] = await Promise.all([
      requestToPromise<DocumentTextOrderOverride | undefined>(store.get(override.id)),
      requestToPromise<SyncTombstone | undefined>(
        tombstoneStore.get(tombstoneId('document_text_order_override', override.id)),
      ),
    ]);
    if (tombstone && !isRemoteNewer(override.updatedAt, tombstone.deletedAt)) return;
    if (!existing || isRemoteNewer(override.updatedAt, existing.updatedAt)) store.put(override);
    tombstoneStore.delete(tombstoneId('document_text_order_override', override.id));
    return;
  }

  if (event.type === 'document_text_order_override_deleted') {
    const payload = recordValue(event.payload);
    const nested = recordValue(payload.orderOverride);
    const id = stringField(payload.id) || stringField(nested.id) || event.entityId;
    if (!id) return;
    const deletedAt = deleteEventTimestamp(event);
    const store = tx.objectStore(DOCUMENT_LISTENING_STORES.documentTextOrderOverrides);
    const existing = await requestToPromise<DocumentTextOrderOverride | undefined>(store.get(id));
    if (existing && !isRemoteNewer(deletedAt, existing.updatedAt)) return;
    store.delete(id);
    const pageIndex = numberField(payload.pageIndex, numberField(nested.pageIndex, existing?.pageIndex ?? Number.NaN));
    tx.objectStore('sync_tombstones').put({
      ...tombstoneEntity('document_text_order_override', id, deletedAt, existing?.bookId ?? event.novelId),
      pageIndex: Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex : undefined,
    });
    return;
  }

  if (event.type === 'character_graph_updated') {
    const graph = remoteCharacterGraph(event);
    if (!graph) return;
    const characterStore = tx.objectStore('characters');
    const relationStore = tx.objectStore('character_relations');
    const existingCharacters = await requestToPromise<Character[]>(
      characterStore.index('novelId').getAll(graph.novelId),
    );
    const existingById = new Map(existingCharacters.map((character) => [character.id, character]));
    if (graph.mode === 'replace') {
      const incomingCharacterIds = new Set(graph.characters.map((character) => character.id));
      for (const character of existingCharacters) {
        if (!incomingCharacterIds.has(character.id) && !character.isUserConfirmed) characterStore.delete(character.id);
      }
    }
    for (const character of graph.characters)
      characterStore.put(mergeRemoteCharacter(existingById.get(character.id), character));

    if (graph.relations) {
      if (graph.mode === 'replace') deleteByIndexInTransaction(tx, 'character_relations', 'novelId', graph.novelId);
      for (const relation of graph.relations) relationStore.put(relation);
    }
    return;
  }

  if (event.type === 'chapter_segments_updated') {
    const chapterSegments = remoteChapterSegments(event);
    if (!chapterSegments) return;
    const store = tx.objectStore('segments');
    const incomingIds = new Set(chapterSegments.segments.map((segment) => segment.id));
    const patchParagraphIds = chapterSegments.mode === 'patch' ? new Set(chapterSegments.paragraphIds) : undefined;
    const existingSegments = await requestToPromise<LabeledSegment[]>(
      store.index('chapterId').getAll(chapterSegments.chapterId),
    );
    const existingById = new Map(existingSegments.map((segment) => [segment.id, segment]));
    for (const segment of existingSegments) {
      const inScope = !patchParagraphIds || patchParagraphIds.has(segment.paragraphId);
      if (inScope && !segment.isUserCorrected && !incomingIds.has(segment.id)) store.delete(segment.id);
    }
    for (const segment of chapterSegments.segments) {
      const existing = existingById.get(segment.id);
      if (existing?.isUserCorrected && !segment.isUserCorrected) continue;
      store.put(segment);
    }
    return;
  }

  if (event.type === 'voice_profiles_updated' && event.novelId) {
    const profiles = remoteVoiceProfiles(event);
    if (!profiles) return;
    deleteByIndexInTransaction(tx, 'voice_profiles', 'novelId', event.novelId);
    for (const profile of profiles) tx.objectStore('voice_profiles').put(profile);
    return;
  }

  if (event.type === 'user_correction_created') {
    const correction = remoteCorrection(event);
    if (!correction) return;
    const correctionStore = tx.objectStore('corrections');
    const tombstoneStore = tx.objectStore('sync_tombstones');
    const tombstone = await requestToPromise<SyncTombstone | undefined>(
      tombstoneStore.get(tombstoneId('user_correction', correction.id)),
    );
    if (tombstone && !isRemoteNewer(correction.createdAt, tombstone.deletedAt)) return;
    correctionStore.put(correction);
    tombstoneStore.delete(tombstoneId('user_correction', correction.id));
    if (!correction.segmentId) return;
    const segmentStore = tx.objectStore('segments');
    const segment = await requestToPromise<LabeledSegment | undefined>(segmentStore.get(correction.segmentId));
    if (!segment || segment.novelId !== correction.novelId || segment.chapterId !== correction.chapterId) return;
    const after = recordValue(jsonFromString(correction.afterJson));
    if (correction.correctionType === 'speaker') {
      const speakerId = stringField(after.speakerId);
      if (speakerId) {
        segmentStore.put({
          ...segment,
          speakerId,
          candidateSpeakers: speakerId === 'unknown' ? segment.candidateSpeakers : [speakerId],
          confidence: speakerId === 'unknown' ? segment.confidence : 1,
          evidence: speakerId === 'unknown' ? segment.evidence : 'User-corrected label.',
          voiceProfileId: undefined,
          isUserCorrected: speakerId === 'unknown' ? segment.isUserCorrected : true,
        });
      }
    }
    if (correction.correctionType === 'emotion') {
      const emotion = stringField(after.emotion);
      if (emotion) {
        segmentStore.put({
          ...segment,
          emotion,
          isUserCorrected: true,
        });
      }
    }
    return;
  }

  if (event.type === 'user_correction_deleted') {
    const payload = recordValue(event.payload);
    const id = stringField(payload.id) || event.entityId;
    if (!id) return;
    const deletedAt = deleteEventTimestamp(event);
    const correctionStore = tx.objectStore('corrections');
    const existing = await requestToPromise<UserCorrection | undefined>(correctionStore.get(id));
    if (existing && !isRemoteNewer(deletedAt, existing.createdAt)) return;
    correctionStore.delete(id);
    tx.objectStore('sync_tombstones').put(
      tombstoneEntity('user_correction', id, deletedAt, existing?.novelId ?? event.novelId),
    );
  }
}

export async function applyRemoteSyncEvents(events: SyncEvent[]): Promise<void> {
  if (!events.length) return;
  const db = await openReaderDb();
  const tx = db.transaction(
    [
      'novels',
      ...BOOK_DATA_STORES,
      BOOK_ASSET_STORES.assets,
      BOOK_ASSET_STORES.blobs,
      LIBRARY_MANAGEMENT_STORES.shelves,
      'settings',
    ],
    'readwrite',
  );
  for (const event of events) {
    await applyRemoteSyncEvent(tx, event);
  }
  await transactionDone(tx);
}

async function* pageBatchesFromSnapshot(snapshot: RemoteBookSnapshot): AsyncGenerator<ParagraphPage[]> {
  for (const batch of chunked(snapshot.paragraphPages, IMPORT_PAGE_BATCH_SIZE)) {
    yield batch;
  }
}

export async function cacheRemoteBookSnapshotStream(snapshot: RemoteBookSnapshotStream): Promise<void> {
  const chapters = [...snapshot.chapters].sort((a, b) => a.index - b.index).map(storedChapter);
  const expected: ContentRevisionExpectedCounts = {
    chapterCount: snapshot.expectedChapterCount ?? snapshot.novel.totalChapters,
    pageCount: snapshot.expectedPageCount,
    paragraphCount: snapshot.expectedParagraphCount ?? snapshot.novel.totalParagraphs,
  };
  const validation = createContentRevisionValidationState({
    novel: snapshot.novel,
    chapters,
    expected,
    contentHash: snapshot.contentHash,
  });
  const revision = await createStagingContentRevision({
    novel: snapshot.novel,
    source: 'remote_snapshot',
    sourceRevision: snapshot.sourceRevision,
    sourceHash: snapshot.contentHash,
    expected,
  });
  try {
    const oldIndex = await buildCachedBookChildIdIndex(snapshot.novel.id);
    const nextIndex = createBookChildIdIndex(chapters);
    await saveStagedContentChapters(revision.id, chapters, {});
    for await (const pageBatch of snapshot.pageBatches) {
      validateContentRevisionPageBatch(validation, pageBatch);
      addParagraphPagesToChildIdIndex(nextIndex, pageBatch);
      await saveStagedContentPageBatch(revision.id, pageBatch);
    }
    const actual = finalizeContentRevisionValidation(validation);
    const activation = await prepareContentActivationReaderPlan(snapshot, oldIndex, nextIndex, revision.id);
    await activateStagedContentRevision({
      revision,
      actual,
      novel: activation.novel,
      emitBookImported: false,
      readerPlan: activation.readerPlan,
    });
  } catch (error) {
    await cleanupStagingContentRevision(revision.id);
    throw error;
  }
}

export async function cacheRemoteBookSnapshot(snapshot: RemoteBookSnapshot): Promise<void> {
  await cacheRemoteBookSnapshotStream({
    novel: snapshot.novel,
    chapters: snapshot.chapters,
    readingPosition: snapshot.readingPosition,
    pageBatches: pageBatchesFromSnapshot(snapshot),
    sourceRevision: snapshot.sourceRevision,
    contentHash: snapshot.contentHash,
    expectedChapterCount: snapshot.expectedChapterCount,
    expectedPageCount: snapshot.expectedPageCount ?? snapshot.paragraphPages.length,
    expectedParagraphCount: snapshot.expectedParagraphCount,
  });
}

async function saveImportedParagraphPages(
  contentRevisionId: string,
  chapterParagraphs: ParsedNovelImportChapterSource,
  validation: ContentRevisionValidationState,
  options: SaveImportedNovelOptions,
  totals: Pick<SaveImportedNovelProgress, 'chaptersWritten' | 'totalChapters' | 'totalPages' | 'totalParagraphs'>,
  nextIndex?: BookChildIdIndex,
): Promise<StoredContentRevisionCounts> {
  let pagesWritten = 0;
  let paragraphsWritten = 0;
  const batchPageCount = options.batchPageCount ?? IMPORT_PAGE_BATCH_SIZE;

  const writeBatch = async (batch: ParagraphPage[]) => {
    if (!batch.length) return;
    throwIfImportCancelled(options);
    validateContentRevisionPageBatch(validation, batch);
    if (nextIndex) addParagraphPagesToChildIdIndex(nextIndex, batch);
    await saveStagedContentPageBatch(contentRevisionId, batch);

    pagesWritten += batch.length;
    paragraphsWritten += batch.reduce((sum, page) => sum + page.paragraphs.length, 0);
    await options.onProgress?.({
      phase: 'writing_pages',
      ...totals,
      pagesWritten,
      paragraphsWritten,
    });
    throwIfImportCancelled(options);
  };

  let batch: ParagraphPage[] = [];
  for await (const chapterParagraph of chapterParagraphs) {
    throwIfImportCancelled(options);
    for (const page of iterateChapterParagraphPages(chapterParagraph)) {
      throwIfImportCancelled(options);
      batch.push(page);
      if (batch.length >= batchPageCount) {
        await writeBatch(batch);
        batch = [];
      }
    }
  }
  await writeBatch(batch);
  return finalizeContentRevisionValidation(validation);
}

async function stageAndActivateImportedNovel(input: {
  novel: Novel;
  chapters: Chapter[];
  chapterParagraphs: ParsedNovelImportChapterSource;
  embeddedAssets?: readonly ParsedNovelImportAsset[];
  embeddedAssetStream?: AsyncIterable<ParsedNovelImportAsset>;
  options: SaveImportedNovelOptions;
}): Promise<void> {
  const allChapters = [...input.chapters].sort((a, b) => a.index - b.index).map(storedChapter);
  const appendDelta = await planAppendDeltaImport(input.novel, allChapters, input.options);
  const chapters = appendDelta?.chapters ?? allChapters;
  const paragraphCount = chapters.reduce((total, chapter) => total + chapter.paragraphCount, 0);
  const expected: ContentRevisionExpectedCounts = {
    chapterCount: chapters.length,
    pageCount: countParagraphPages(chapters),
    paragraphCount,
  };
  const validation = createContentRevisionValidationState({
    novel: input.novel,
    chapters,
    expected,
  });
  const revision = await createStagingContentRevision({
    novel: input.novel,
    source: 'local_import',
    sourceHash: input.novel.rawTextHash || input.novel.normalizedTextHash,
    expected,
    expectedBaseActiveContentRevisionId: input.options.expectedBaseActiveContentRevisionId,
    appendDelta: appendDelta
      ? { baseRevision: appendDelta.baseRevision, logicalCounts: appendDelta.logicalCounts }
      : undefined,
  });
  let stagedSourceAssetId: string | undefined;
  let stagedEmbeddedAssetIds: string[] = [];
  try {
    if (input.options.sourceAsset) {
      const sourceAsset = await stageOriginalSourceAsset({
        ...input.options.sourceAsset,
        bookId: input.novel.id,
        contentRevisionId: revision.id,
      });
      stagedSourceAssetId = sourceAsset.id;
    }
    if (input.embeddedAssets?.length) {
      stagedEmbeddedAssetIds = await stageEmbeddedBookAssets(input.novel.id, revision.id, input.embeddedAssets);
    }
    if (input.embeddedAssetStream) {
      for await (const asset of input.embeddedAssetStream) {
        throwIfImportCancelled(input.options);
        const [stagedId] = await stageEmbeddedBookAssets(input.novel.id, revision.id, [asset]);
        if (stagedId) stagedEmbeddedAssetIds.push(stagedId);
      }
    }
    const replacingExistingNovel = revision.baseNovelPresent && !appendDelta;
    const oldIndex = replacingExistingNovel
      ? await buildCachedBookChildIdIndex(input.novel.id)
      : createBookChildIdIndex([]);
    const nextIndex = createBookChildIdIndex(chapters);
    throwIfImportCancelled(input.options);
    const chaptersWritten = await saveStagedContentChapters(revision.id, chapters, input.options);
    throwIfImportCancelled(input.options);
    const actual = await saveImportedParagraphPages(
      revision.id,
      appendDelta
        ? selectChapterParagraphs(input.chapterParagraphs, new Set(chapters.map((chapter) => chapter.id)))
        : input.chapterParagraphs,
      validation,
      input.options,
      {
        chaptersWritten,
        totalChapters: chapters.length,
        totalPages: countParagraphPages(chapters),
        totalParagraphs: expected.paragraphCount,
      },
      replacingExistingNovel ? nextIndex : undefined,
    );
    throwIfImportCancelled(input.options);
    const activationProgress: SaveImportedNovelProgress = {
      phase: 'activating_revision',
      chaptersWritten,
      pagesWritten: actual.pageCount,
      paragraphsWritten: actual.paragraphCount,
      totalChapters: chapters.length,
      totalPages: actual.pageCount,
      totalParagraphs: expected.paragraphCount,
    };
    let activationNovel = input.novel;
    let readerPlan: ContentActivationReaderPlan | undefined;
    if (!appendDelta && (revision.baseNovelPresent || input.options.extendReaderPlan)) {
      const activation = await prepareContentActivationReaderPlan(
        { novel: input.novel, chapters: allChapters, readingPosition: undefined },
        oldIndex,
        nextIndex,
        revision.id,
      );
      activationNovel = activation.novel;
      readerPlan = input.options.extendReaderPlan?.(activation.readerPlan) ?? activation.readerPlan;
    }
    await withImportProgressHeartbeat(
      input.options.onProgress,
      activationProgress,
      () =>
        activateStagedContentRevision({
          revision,
          actual,
          novel: storedNovel(activationNovel),
          emitBookImported: true,
          readerPlan,
          shouldCancel: input.options.shouldCancel,
          sourceAssetId: stagedSourceAssetId,
          embeddedAssetIds: [...stagedEmbeddedAssetIds, ...(input.options.retainedEmbeddedAssetIds ?? [])],
          embeddedAssetPageIndexes: input.options.embeddedAssetPageIndexes,
          preserveExistingEmbeddedAssets: Boolean(appendDelta) || input.options.preserveExistingEmbeddedAssets,
          preserveExistingCover: input.options.preserveExistingCover,
        }),
      input.options.shouldCancel,
    );
  } catch (error) {
    await Promise.allSettled([
      cleanupStagingContentRevision(revision.id),
      ...(stagedSourceAssetId ? [cleanupStagedBookAsset(stagedSourceAssetId)] : []),
      ...stagedEmbeddedAssetIds.map((id) => cleanupStagedBookAsset(id)),
    ]);
    throw error;
  }
}

export async function saveImportedNovel(parsed: ParsedNovel, options: SaveImportedNovelOptions = {}): Promise<void> {
  const chapters = [...parsed.chapters].sort((a, b) => a.index - b.index);
  const paragraphsByChapter = groupParagraphsByChapter(parsed.paragraphs);
  await stageAndActivateImportedNovel({
    novel: parsed.novel,
    chapters,
    chapterParagraphs: iterateParsedNovelChapters(chapters, paragraphsByChapter),
    options,
  });
}

export async function saveParsedNovelImport(
  parsed: ParsedNovelImport,
  options: SaveImportedNovelOptions = {},
): Promise<void> {
  await stageAndActivateImportedNovel({
    novel: parsed.novel,
    chapters: parsed.chapters,
    chapterParagraphs: parsed.consumeChapterParagraphs(),
    embeddedAssets: parsed.embeddedAssets,
    embeddedAssetStream: parsed.consumeEmbeddedAssets?.(),
    options,
  });
}

export async function deleteNovel(novelId: string, expectedRevision?: number): Promise<void> {
  await moveNovelToTrash(novelId, expectedRevision);
}
