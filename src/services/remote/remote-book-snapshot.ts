import type { Chapter, EncodingMode, Novel, Paragraph, ParagraphPage, ReadingPosition } from '../../domain/types';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import type { RemoteBookSnapshot, RemoteBookSnapshotStream } from '../../sync/types';

export type SnapshotJsonRecord = Record<string, unknown>;
export type SnapshotAwareResponse<T> = T & SnapshotJsonRecord;
export type RemoteBookManifestResponse = SnapshotAwareResponse<{
  book: SnapshotJsonRecord;
  readingPosition: SnapshotJsonRecord | null;
}>;
export type RemoteChapterListResponse = SnapshotAwareResponse<{ chapters: SnapshotJsonRecord[] }>;
export type RemotePageListResponse = SnapshotAwareResponse<{ pages: SnapshotJsonRecord[] }>;
export type RemoteNotFoundPredicate = (error: unknown) => boolean;

interface RemoteSnapshotPin {
  sourceRevision?: string;
  contentHash?: string;
  fingerprint: string;
}

export interface RemoteSnapshotTransport {
  getBookManifest(bookId: string, sourceRevision?: string): Promise<RemoteBookManifestResponse>;
  listChapters(bookId: string, sourceRevision?: string): Promise<RemoteChapterListResponse>;
  listPages(chapterId: string, from?: number, count?: number, sourceRevision?: string): Promise<RemotePageListResponse>;
}

export class RemoteSnapshotRevisionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteSnapshotRevisionMismatchError';
  }
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function optionalJsonRecord(value: unknown): SnapshotJsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as SnapshotJsonRecord) : undefined;
}

function firstString(records: Array<SnapshotJsonRecord | undefined>, keys: string[]): string | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function snapshotMetadataRecords(response: SnapshotJsonRecord): Array<SnapshotJsonRecord | undefined> {
  return [response, optionalJsonRecord(response.snapshot), optionalJsonRecord(response.book)];
}

function snapshotSourceRevision(response: SnapshotJsonRecord): string | undefined {
  return firstString(snapshotMetadataRecords(response), [
    'contentRevisionId',
    'content_revision_id',
    'snapshotRevision',
    'snapshot_revision',
    'sourceRevision',
    'source_revision',
  ]);
}

function snapshotContentHash(response: SnapshotJsonRecord): string | undefined {
  return firstString(snapshotMetadataRecords(response), [
    'contentHash',
    'content_hash',
    'normalizedTextHash',
    'normalized_text_hash',
  ]);
}

function snapshotManifestFingerprint(manifest: SnapshotAwareResponse<{ book: SnapshotJsonRecord }>): string {
  const book = manifest.book;
  const contentHash = snapshotContentHash(manifest);
  return JSON.stringify([
    stringValue(book.id),
    contentHash || stringValue(book.updated_at) || stringValue(book.updatedAt),
    numberValue(book.total_chapters ?? book.totalChapters),
    numberValue(book.total_paragraphs ?? book.totalParagraphs),
    numberValue(book.total_characters ?? book.totalCharacters),
  ]);
}

function assertSnapshotPin(pin: RemoteSnapshotPin, response: SnapshotJsonRecord, context: string): void {
  const responseRevision = snapshotSourceRevision(response);
  if (pin.sourceRevision && responseRevision && responseRevision !== pin.sourceRevision) {
    throw new RemoteSnapshotRevisionMismatchError(
      `${context} returned content revision ${responseRevision}; expected ${pin.sourceRevision}`,
    );
  }
  const responseHash = snapshotContentHash(response);
  if (pin.contentHash && responseHash && responseHash !== pin.contentHash) {
    throw new RemoteSnapshotRevisionMismatchError(`${context} returned a different content hash`);
  }
}

export function snapshotQueryPath(path: string, sourceRevision?: string): string {
  if (!sourceRevision) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}contentRevisionId=${encodeURIComponent(sourceRevision)}`;
}

export function mapServerBook(row: SnapshotJsonRecord): Novel {
  return {
    id: stringValue(row.id),
    format: stringValue(row.format, 'txt') as Novel['format'],
    activeContentRevisionId: stringValue(row.active_content_revision_id) || undefined,
    sourceAssetId: stringValue(row.source_asset_id) || undefined,
    sourceProvenance: stringValue(row.source_asset_id) ? 'original' : undefined,
    sourceByteLength: numberValue(row.source_byte_length) || undefined,
    sourceContentType: stringValue(row.source_content_type) || undefined,
    sourceContentHash: stringValue(row.source_content_hash) || undefined,
    title: stringValue(row.title, 'Untitled'),
    author: stringValue(row.author) || undefined,
    seriesTitle: stringValue(row.series_title ?? row.seriesTitle) || undefined,
    seriesIndex:
      row.series_index === null || row.series_index === undefined
        ? undefined
        : numberValue(row.series_index ?? row.seriesIndex),
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    description: stringValue(row.description) || undefined,
    language: stringValue(row.language) || undefined,
    coverAssetId: stringValue(row.cover_asset_id ?? row.coverAssetId) || undefined,
    coverContentHash: stringValue(row.cover_content_hash ?? row.coverContentHash) || undefined,
    coverFit: stringValue(row.cover_fit ?? row.coverFit, 'crop') as Novel['coverFit'],
    coverPositionX: numberValue(row.cover_position_x ?? row.coverPositionX, 50),
    coverPositionY: numberValue(row.cover_position_y ?? row.coverPositionY, 50),
    sourceFileName: stringValue(row.source_file_name),
    sourceEncoding: stringValue(row.source_encoding, 'auto') as EncodingMode,
    rawText: '',
    normalizedText: '',
    rawTextHash: stringValue(row.source_content_hash),
    normalizedTextHash: stringValue(row.normalized_text_hash),
    createdAt: stringValue(row.created_at, new Date(0).toISOString()),
    updatedAt: stringValue(row.updated_at, new Date(0).toISOString()),
    totalChapters: numberValue(row.total_chapters),
    totalCharacters: numberValue(row.total_characters),
    totalParagraphs: numberValue(row.total_paragraphs),
    coverSeed: numberValue(row.cover_seed),
    lastReadChapterId: stringValue(row.last_read_chapter_id) || undefined,
    lastReadParagraphId: stringValue(row.last_read_paragraph_id) || undefined,
    lastReadOffset: numberValue(row.last_read_offset),
    lastReadProgress: numberValue(row.last_read_progress),
    readingSeconds: numberValue(row.reading_seconds),
    lastReadAt: stringValue(row.last_read_at) || undefined,
    favorite: booleanValue(row.favorite),
    analysisStatus: stringValue(row.analysis_status, 'not_analyzed') as Novel['analysisStatus'],
    metadataRevision: numberValue(row.metadata_revision),
    deletedAt: stringValue(row.deleted_at) || undefined,
    deletedByDeviceId: stringValue(row.deleted_by_device_id) || undefined,
  };
}

export function mapServerChapter(row: SnapshotJsonRecord): Chapter {
  return {
    id: stringValue(row.id),
    novelId: stringValue(row.book_id),
    index: numberValue(row.chapter_index),
    title: stringValue(row.title),
    normalizedText: '',
    textHash: stringValue(row.text_hash),
    rawStartOffset: numberValue(row.raw_start_offset),
    rawEndOffset: numberValue(row.raw_end_offset),
    characterCount: numberValue(row.character_count),
    paragraphCount: numberValue(row.paragraph_count),
    createdAt: stringValue(row.created_at, new Date(0).toISOString()),
    updatedAt: stringValue(row.updated_at, new Date(0).toISOString()),
  };
}

export function mapServerParagraphPage(row: SnapshotJsonRecord): ParagraphPage {
  return {
    id: stringValue(row.id),
    novelId: stringValue(row.book_id),
    chapterId: stringValue(row.chapter_id),
    pageIndex: numberValue(row.page_index),
    startParagraphIndex: numberValue(row.start_paragraph_index),
    endParagraphIndex: numberValue(row.end_paragraph_index),
    paragraphs: Array.isArray(row.paragraphs) ? (row.paragraphs as Paragraph[]) : [],
    textHash: stringValue(row.text_hash),
  };
}

export function mapServerReadingPosition(row: SnapshotJsonRecord | undefined | null): ReadingPosition | undefined {
  if (!row) return undefined;
  const bookId = stringValue(row.book_id);
  return {
    id: `reading_position_${bookId}`,
    novelId: bookId,
    chapterId: stringValue(row.chapter_id),
    paragraphId: stringValue(row.paragraph_id) || undefined,
    paragraphIndex: numberValue(row.paragraph_index),
    offsetInParagraph: numberValue(row.offset_in_paragraph),
    chapterProgress: numberValue(row.chapter_progress),
    scrollTop: numberValue(row.scroll_top),
    deviceId: stringValue(row.device_id, 'server'),
    updatedAt: stringValue(row.updated_at, new Date(0).toISOString()),
  };
}

function applyPosition(novel: Novel, position?: ReadingPosition): Novel {
  if (!position) return novel;
  return {
    ...novel,
    lastReadChapterId: position.chapterId,
    lastReadParagraphId: position.paragraphId,
    lastReadOffset: position.scrollTop,
    lastReadProgress: position.chapterProgress,
    updatedAt: position.updatedAt,
  };
}

async function* pageBatchesForSnapshot(
  transport: RemoteSnapshotTransport,
  bookId: string,
  chapters: Chapter[],
  pin: RemoteSnapshotPin,
): AsyncGenerator<ParagraphPage[]> {
  for (const chapter of chapters) {
    for (let from = 0; ; from += 20) {
      const response = await transport.listPages(chapter.id, from, 20, pin.sourceRevision);
      assertSnapshotPin(pin, response, `chapter ${chapter.id} page batch ${from}`);
      const pages = response.pages.map(mapServerParagraphPage);
      if (pages.length) yield pages;
      if (pages.length < 20) break;
    }
  }
  const finalManifest = await transport.getBookManifest(bookId, pin.sourceRevision);
  assertSnapshotPin(pin, finalManifest, 'final book manifest');
  if (snapshotManifestFingerprint(finalManifest) !== pin.fingerprint) {
    throw new RemoteSnapshotRevisionMismatchError('book content changed while the snapshot was streaming');
  }
}

export async function getRemoteBookSnapshotStream(
  transport: RemoteSnapshotTransport,
  bookId: string,
  isNotFound?: RemoteNotFoundPredicate,
): Promise<RemoteBookSnapshotStream | undefined> {
  try {
    const manifest = await transport.getBookManifest(bookId);
    const readingPosition = mapServerReadingPosition(manifest.readingPosition);
    const novel = applyPosition(mapServerBook(manifest.book), readingPosition);
    const pin: RemoteSnapshotPin = {
      sourceRevision: snapshotSourceRevision(manifest),
      contentHash: snapshotContentHash(manifest),
      fingerprint: snapshotManifestFingerprint(manifest),
    };
    const chapterResponse = await transport.listChapters(bookId, pin.sourceRevision);
    assertSnapshotPin(pin, chapterResponse, 'book chapter manifest');
    const chapters = chapterResponse.chapters.map(mapServerChapter);
    return {
      novel,
      chapters,
      readingPosition,
      pageBatches: pageBatchesForSnapshot(transport, bookId, chapters, pin),
      sourceRevision: pin.sourceRevision,
      contentHash: pin.contentHash,
      expectedChapterCount: novel.totalChapters,
      expectedPageCount: chapters.reduce(
        (total, chapter) => total + Math.ceil(chapter.paragraphCount / PARAGRAPHS_PER_PAGE),
        0,
      ),
      expectedParagraphCount: novel.totalParagraphs,
    };
  } catch (error) {
    if (isNotFound?.(error)) return undefined;
    throw error;
  }
}

export async function materializeRemoteBookSnapshot(stream: RemoteBookSnapshotStream): Promise<RemoteBookSnapshot> {
  const paragraphPages: ParagraphPage[] = [];
  for await (const pages of stream.pageBatches) {
    paragraphPages.push(...pages);
  }
  return {
    novel: stream.novel,
    chapters: stream.chapters,
    paragraphPages,
    readingPosition: stream.readingPosition,
    sourceRevision: stream.sourceRevision,
    contentHash: stream.contentHash,
    expectedChapterCount: stream.expectedChapterCount,
    expectedPageCount: stream.expectedPageCount,
    expectedParagraphCount: stream.expectedParagraphCount,
  };
}

export async function getRemoteBookSnapshot(
  transport: RemoteSnapshotTransport,
  bookId: string,
  isNotFound?: RemoteNotFoundPredicate,
): Promise<RemoteBookSnapshot | undefined> {
  const stream = await getRemoteBookSnapshotStream(transport, bookId, isNotFound);
  if (!stream) return undefined;
  try {
    return await materializeRemoteBookSnapshot(stream);
  } catch (error) {
    if (isNotFound?.(error)) return undefined;
    throw error;
  }
}
