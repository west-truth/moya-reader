import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ServerConfig } from '../config.js';
import { createS3Client, getObjectBuffer, inspectStoredObject, putRawBookObject } from './object-storage.js';
import { parseNovelFileForImport } from '@noveldesk/text-core/parser';
import { materializeEpubImport, parseEpub } from '@noveldesk/epub-core';
import {
  hasDocumentSeriesManifest,
  materializeDocumentSeriesArchive,
  isRemoteDocumentSeriesImport,
} from '@noveldesk/document-series-core';
import {
  materializePdfImport,
  materializeStreamingImageArchiveImport,
  openImageArchiveStream,
} from '@noveldesk/fixed-document-core';
import type {
  Chapter,
  ChapterSplitMode,
  EncodingMode,
  Paragraph,
  ParagraphPage,
  ParsedNovel,
  ParsedNovelImport,
  ParsedNovelImportAsset,
  ParsedNovelImportChapter,
  ParsedNovelImportChapterSource,
} from '@noveldesk/contracts';
import { integrityHash, persistentId128 } from '@noveldesk/text-core/hash';
import { paragraphPageId, parsedChapterId, parsedParagraphId } from '@noveldesk/text-core/identity/parser';
import { validateUploadCompleteness } from './upload-validation.js';
import { removeUploadDirectory } from './upload-cleanup.js';
import {
  finalizeBookReplacement,
  prepareBookReplacement,
  restoreExactAnchoredReaderState,
} from './book-revision/service.js';
import {
  enqueueObjectDeletions,
  releaseObjectDeletionReservations,
  reserveObjectDeletions,
} from './object-delete-outbox.js';
import {
  COMIC_SOURCE_CONTENT_TYPE,
  comicPageAssetId,
  materializeComicSource,
  planComicSourceAppend,
  unpackComicSource,
  type ComicSourceAppendPlan,
} from '@noveldesk/fixed-document-core/comic-source';
import { loadImportPageReuse } from './import-page-reuse.js';
import { retainComicAssets } from './comic-source-retention.js';
import { ImportMeasurements } from './import-measurements.js';
import type { StructuredLogger } from '../observability/logger.js';
import { insertParagraphSearchBatch } from './paragraph-search-persistence.js';
import { createImportProgressUpdateThrottle } from './import-progress-throttle.js';
import { assertImportExpectedBase, parseImportExpectedBase } from './import-expected-base.js';

const PARAGRAPHS_PER_PAGE = 120;
const SERVER_IMPORT_CHAPTER_BATCH_SIZE = 100;
const SERVER_IMPORT_PAGE_BATCH_SIZE = 25;
const SERVER_IMPORT_EAGER_ASSET_CONCURRENCY = 4;
const POSITIVE_SIGNED_INTEGER_MODULUS = 0x80000000;

export function normalizeCoverSeedForPersistence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return (
    ((integer % POSITIVE_SIGNED_INTEGER_MODULUS) + POSITIVE_SIGNED_INTEGER_MODULUS) % POSITIVE_SIGNED_INTEGER_MODULUS
  );
}

interface UploadSessionRow {
  id: string;
  user_id: string;
  file_name: string;
  size_bytes: string;
  content_type: string;
  encoding: EncodingMode;
  chapter_split_mode?: ChapterSplitMode;
  total_chunks: number | null;
  client_book_id?: string | null;
  source_content_hash?: string | null;
  import_mode?: 'replace_book' | 'append_image_series';
  base_active_content_revision_id?: string | null;
  expected_base?: import('@noveldesk/contracts').ImportExpectedBase | null;
}

interface ImageSeriesAppendBaseRow {
  readonly id: string;
  readonly format: string;
  readonly active_content_revision_id: string;
  readonly source_file_name: string;
  readonly storage_key: string;
  readonly content_type: string;
  readonly total_chapters: number | string;
  readonly raw_text_hash: string;
}

interface UploadChunkRow {
  chunk_index: number;
  size_bytes: number;
  storage_path: string;
}

type ImportJobStage =
  'queued' | 'reading' | 'decoding' | 'splitting_chapters' | 'writing' | 'ready' | 'failed' | 'cancelled';

interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

interface CommandQueryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

interface ImportJobProgressPatch {
  status?: 'queued' | 'processing' | 'done' | 'failed' | 'cancelled';
  stage?: ImportJobStage;
  bytesRead?: number;
  totalBytes?: number;
  chaptersDetected?: number;
  paragraphsWritten?: number;
  message?: string | null;
  bookId?: string;
  errorMessage?: string | null;
}

export interface ImportExecutionAttempt {
  readonly attemptNumber: number;
  readonly maxAttempts: number;
  readonly finalAttempt: boolean;
  readonly executionId?: string;
}

const SINGLE_IMPORT_ATTEMPT: ImportExecutionAttempt = {
  attemptNumber: 1,
  maxAttempts: 1,
  finalAttempt: true,
};

const IMPORT_JOB_HEARTBEAT_MS = 30_000;

async function updateImportJobProgress(
  queryable: Queryable,
  jobId: string,
  patch: ImportJobProgressPatch,
  executionId?: string,
): Promise<boolean> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  const setValue = (column: string, value: unknown) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };

  if (patch.status !== undefined) setValue('status', patch.status);
  if (patch.stage !== undefined) setValue('stage', patch.stage);
  if (patch.bytesRead !== undefined) setValue('bytes_read', Math.max(0, Math.round(patch.bytesRead)));
  if (patch.totalBytes !== undefined) setValue('total_bytes', Math.max(0, Math.round(patch.totalBytes)));
  if (patch.chaptersDetected !== undefined)
    setValue('chapters_detected', Math.max(0, Math.round(patch.chaptersDetected)));
  if (patch.paragraphsWritten !== undefined)
    setValue('paragraphs_written', Math.max(0, Math.round(patch.paragraphsWritten)));
  if (patch.message !== undefined) setValue('message', patch.message);
  if (patch.bookId !== undefined) setValue('book_id', patch.bookId);
  if (patch.errorMessage !== undefined) setValue('error_message', patch.errorMessage);
  if (!assignments.length) return true;

  values.push(jobId);
  const jobParameter = values.length;
  if (executionId) values.push(executionId);
  const result = await queryable.query(
    `update import_jobs set ${assignments.join(', ')}, updated_at = now()
      where id = $${jobParameter}${
        executionId
          ? ` and active_queue_job_id = $${values.length} and cancel_requested_at is null and status <> 'cancelled'`
          : ''
      }`,
    values,
  );
  const rowCount = (result as pg.QueryResult).rowCount;
  return rowCount === undefined || rowCount === null || rowCount > 0;
}

class ImportExecutionStoppedError extends Error {
  constructor(readonly reason: 'cancelled' | 'superseded') {
    super(reason === 'cancelled' ? 'Import was cancelled' : 'Import execution was superseded');
    this.name = 'ImportExecutionStoppedError';
  }
}

async function claimImportExecution(pool: pg.Pool, jobId: string, executionId?: string): Promise<boolean> {
  if (!executionId) return true;
  const result = await pool.query(
    `update import_jobs
        set status = 'processing', stage = 'reading', message = '업로드 조각을 검증하고 조립하는 중입니다.',
            error_message = null, updated_at = now()
      where id = $1 and status = 'queued' and active_queue_job_id = $2 and cancel_requested_at is null
      returning id`,
    [jobId, executionId],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

async function assertImportExecutionActive(pool: pg.Pool, jobId: string, executionId?: string): Promise<void> {
  if (!executionId) return;
  const result = await pool.query<{
    status: string;
    cancel_requested_at?: string | null;
    active_queue_job_id?: string | null;
  }>('select status, cancel_requested_at, active_queue_job_id from import_jobs where id = $1', [jobId]);
  const row = result.rows[0];
  if (row?.cancel_requested_at || row?.status === 'cancelled') throw new ImportExecutionStoppedError('cancelled');
  if (!row || row.active_queue_job_id !== executionId || row.status !== 'processing') {
    throw new ImportExecutionStoppedError('superseded');
  }
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
    const paragraphs = paragraphsByChapter.get(paragraph.chapterId) ?? [];
    paragraphs.push(paragraph);
    paragraphsByChapter.set(paragraph.chapterId, paragraphs);
  }

  for (const paragraphs of paragraphsByChapter.values()) {
    paragraphs.sort((a, b) => a.index - b.index);
  }

  return paragraphsByChapter;
}

function* iterateParsedNovelChapters(parsed: ParsedNovel): Generator<ParsedNovelImportChapter> {
  const paragraphsByChapter = groupParagraphsByChapter(parsed.paragraphs);
  for (const chapter of parsed.chapters) {
    yield {
      chapter,
      paragraphs: paragraphsByChapter.get(chapter.id) ?? [],
    };
  }
}

function paragraphPage(chapter: Chapter, pageIndex: number, paragraphs: Paragraph[]): ParagraphPage {
  return {
    id: paragraphPageId(chapter.novelId, chapter.id, pageIndex),
    novelId: chapter.novelId,
    chapterId: chapter.id,
    pageIndex,
    startParagraphIndex: paragraphs[0]?.index ?? 0,
    endParagraphIndex: paragraphs[paragraphs.length - 1]?.index ?? 0,
    paragraphs,
    textHash: integrityHash(JSON.stringify(paragraphs.map((paragraph) => paragraph.textHash))),
  };
}

export function* iterateChapterParagraphPages(
  chapter: Chapter,
  paragraphs: Iterable<Paragraph>,
): Generator<ParagraphPage> {
  let pageIndex = 0;
  let pageParagraphs: Paragraph[] = [];
  for (const paragraph of paragraphs) {
    pageParagraphs.push(paragraph);
    if (pageParagraphs.length >= PARAGRAPHS_PER_PAGE) {
      yield paragraphPage(chapter, pageIndex, pageParagraphs);
      pageIndex += 1;
      pageParagraphs = [];
    }
  }
  if (pageParagraphs.length) yield paragraphPage(chapter, pageIndex, pageParagraphs);
}

function* iterateParagraphPages(chapterParagraphs: Iterable<ParsedNovelImportChapter>): Generator<ParagraphPage> {
  for (const { chapter, paragraphs } of chapterParagraphs) {
    yield* iterateChapterParagraphPages(chapter, paragraphs);
  }
}

async function* iterateParagraphPagesAsync(
  chapterParagraphs: ParsedNovelImportChapterSource,
): AsyncGenerator<ParagraphPage> {
  for await (const { chapter, paragraphs } of chapterParagraphs) {
    yield* iterateChapterParagraphPages(chapter, paragraphs);
  }
}

function* iterateParagraphPageBatchesFromChapters(
  chapterParagraphs: Iterable<ParsedNovelImportChapter>,
  batchSize: number,
): Generator<ParagraphPage[]> {
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  let batch: ParagraphPage[] = [];
  for (const page of iterateParagraphPages(chapterParagraphs)) {
    batch.push(page);
    if (batch.length >= safeBatchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

async function* iterateParagraphPageBatchesFromChaptersAsync(
  chapterParagraphs: ParsedNovelImportChapterSource,
  batchSize: number,
): AsyncGenerator<ParagraphPage[]> {
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  let batch: ParagraphPage[] = [];
  for await (const page of iterateParagraphPagesAsync(chapterParagraphs)) {
    batch.push(page);
    if (batch.length >= safeBatchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

export function* iterateParagraphPageBatches(parsed: ParsedNovel, batchSize: number): Generator<ParagraphPage[]> {
  yield* iterateParagraphPageBatchesFromChapters(iterateParsedNovelChapters(parsed), batchSize);
}

function syncChapterSource(
  source: ParsedNovelImportChapterSource,
  operation: string,
): Iterable<ParsedNovelImportChapter> {
  if (Symbol.iterator in Object(source)) return source as Iterable<ParsedNovelImportChapter>;
  throw new TypeError(`${operation} requires a synchronous chapter source`);
}

export function* iterateImportParagraphPageBatches(
  parsed: ParsedNovelImport,
  batchSize: number,
): Generator<ParagraphPage[]> {
  yield* iterateParagraphPageBatchesFromChapters(
    syncChapterSource(parsed.consumeChapterParagraphs(), 'iterateImportParagraphPageBatches'),
    batchSize,
  );
}

export async function* iterateImportParagraphPageBatchesAsync(
  parsed: ParsedNovelImport,
  batchSize: number,
): AsyncGenerator<ParagraphPage[]> {
  yield* iterateParagraphPageBatchesFromChaptersAsync(parsed.consumeChapterParagraphs(), batchSize);
}

export function buildParagraphPages(parsed: ParsedNovel): ParagraphPage[] {
  return Array.from(iterateParagraphPages(iterateParsedNovelChapters(parsed)));
}

export function rekeyParsedNovel(parsed: ParsedNovel, targetBookId?: string | null): ParsedNovel {
  const bookId = targetBookId?.trim();
  if (!bookId || bookId === parsed.novel.id) return parsed;

  const chapterIdByOriginal = new Map<string, string>();
  const chapters = parsed.chapters.map((chapter) => {
    const chapterId = parsedChapterId(bookId, chapter.index, chapter.title);
    chapterIdByOriginal.set(chapter.id, chapterId);
    return {
      ...chapter,
      id: chapterId,
      novelId: bookId,
    };
  });
  const paragraphs = parsed.paragraphs.map((paragraph) => {
    const chapterId = chapterIdByOriginal.get(paragraph.chapterId) ?? paragraph.chapterId;
    return {
      ...paragraph,
      id: parsedParagraphId(bookId, chapterId, paragraph.index - 1, paragraph.text),
      novelId: bookId,
      chapterId,
    };
  });
  return {
    novel: {
      ...parsed.novel,
      id: bookId,
      lastReadChapterId: chapters[0]?.id,
      lastReadParagraphId: undefined,
    },
    chapters,
    paragraphs,
  };
}

export function rekeyParsedNovelImport(parsed: ParsedNovelImport, targetBookId?: string | null): ParsedNovelImport {
  const bookId = targetBookId?.trim();
  if (!bookId || bookId === parsed.novel.id) return parsed;

  const chapterByOriginal = new Map<string, Chapter>();
  const chapters = parsed.chapters.map((chapter) => {
    const rekeyed: Chapter = {
      ...chapter,
      id: parsedChapterId(bookId, chapter.index, chapter.title),
      novelId: bookId,
    };
    chapterByOriginal.set(chapter.id, rekeyed);
    return rekeyed;
  });
  let consumed = false;
  const rekeyParagraphs = function* (chapter: Chapter, paragraphs: Iterable<Paragraph>): Generator<Paragraph> {
    for (const paragraph of paragraphs) {
      yield {
        ...paragraph,
        id: parsedParagraphId(bookId, chapter.id, paragraph.index - 1, paragraph.text),
        novelId: bookId,
        chapterId: chapter.id,
      };
    }
  };
  const rekeyChapterParagraphs = (item: ParsedNovelImportChapter): ParsedNovelImportChapter => {
    const chapter = chapterByOriginal.get(item.chapter.id) ?? item.chapter;
    return {
      chapter,
      paragraphs: rekeyParagraphs(chapter, item.paragraphs),
    };
  };

  return {
    novel: {
      ...parsed.novel,
      id: bookId,
      rawText: '',
      normalizedText: '',
      lastReadChapterId: chapters[0]?.id,
      lastReadParagraphId: undefined,
    },
    chapters,
    consumeChapterParagraphs() {
      if (consumed) return [];
      consumed = true;
      const source = parsed.consumeChapterParagraphs();
      if (Symbol.asyncIterator in Object(source)) {
        return (async function* () {
          for await (const item of source) yield rekeyChapterParagraphs(item);
        })();
      }
      return (function* () {
        for (const item of source as Iterable<ParsedNovelImportChapter>) yield rekeyChapterParagraphs(item);
      })();
    },
  };
}

export async function insertChapterBatch(client: pg.PoolClient, chapters: Chapter[]): Promise<void> {
  if (!chapters.length) return;
  const values: unknown[] = [];
  const rows = chapters.map((chapter) => {
    const offset = values.length;
    values.push(
      chapter.id,
      chapter.novelId,
      chapter.index,
      chapter.title,
      chapter.textHash,
      chapter.rawStartOffset,
      chapter.rawEndOffset,
      chapter.characterCount,
      chapter.paragraphCount,
      chapter.documentSectionId ?? null,
      chapter.documentSectionTitle ?? null,
      chapter.documentSectionIndex ?? null,
      chapter.documentPageIndexInSection ?? null,
      chapter.createdAt,
      chapter.updatedAt,
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15})`;
  });

  await client.query(
    `
      insert into chapters (
        id, book_id, chapter_index, title, text_hash, raw_start_offset, raw_end_offset,
        character_count, paragraph_count, document_section_id, document_section_title,
        document_section_index, document_page_index_in_section, created_at, updated_at
      )
      values ${rows.join(', ')}
      on conflict (id) do update
        set chapter_index = excluded.chapter_index,
            title = excluded.title,
            text_hash = excluded.text_hash,
            raw_start_offset = excluded.raw_start_offset,
            raw_end_offset = excluded.raw_end_offset,
            character_count = excluded.character_count,
            paragraph_count = excluded.paragraph_count,
            document_section_id = excluded.document_section_id,
            document_section_title = excluded.document_section_title,
            document_section_index = excluded.document_section_index,
            document_page_index_in_section = excluded.document_page_index_in_section,
            updated_at = excluded.updated_at
    `,
    values,
  );
}

export async function insertParagraphPageBatch(client: pg.PoolClient, pages: ParagraphPage[]): Promise<number> {
  if (!pages.length) return 0;
  const values: unknown[] = [];
  const rows = pages.map((page) => {
    const offset = values.length;
    values.push(
      page.id,
      page.novelId,
      page.chapterId,
      page.pageIndex,
      page.startParagraphIndex,
      page.endParagraphIndex,
      JSON.stringify(page.paragraphs),
      page.textHash,
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`;
  });

  await client.query(
    `
      insert into paragraph_pages (
        id, book_id, chapter_id, page_index, start_paragraph_index,
        end_paragraph_index, paragraphs, text_hash
      )
      values ${rows.join(', ')}
      on conflict (chapter_id, page_index) do update
        set paragraphs = excluded.paragraphs,
            text_hash = excluded.text_hash,
            start_paragraph_index = excluded.start_paragraph_index,
            end_paragraph_index = excluded.end_paragraph_index
    `,
    values,
  );

  await insertParagraphSearchBatch(client, pages);

  return pages.reduce((sum, page) => sum + page.paragraphs.length, 0);
}

export async function replaceParsedBookContent(client: CommandQueryable, bookId: string): Promise<void> {
  await client.query('delete from paragraph_search where book_id = $1', [bookId]);
  await client.query('delete from paragraph_pages where book_id = $1', [bookId]);
  await client.query('delete from chapters where book_id = $1', [bookId]);
}

async function readUploadBuffer(
  pool: pg.Pool,
  uploadId: string,
): Promise<{ session: UploadSessionRow; buffer: Buffer }> {
  const sessionResult = await pool.query<UploadSessionRow>('select * from upload_sessions where id = $1', [uploadId]);
  const session = sessionResult.rows[0];
  if (!session) throw new Error(`Upload session not found: ${uploadId}`);

  const chunksResult = await pool.query<UploadChunkRow>(
    'select chunk_index, size_bytes, storage_path from upload_chunks where upload_id = $1 order by chunk_index asc',
    [uploadId],
  );
  if (!chunksResult.rows.length) throw new Error(`Upload has no chunks: ${uploadId}`);

  const validation = validateUploadCompleteness({
    expectedBytes: Number(session.size_bytes),
    totalChunks: session.total_chunks,
    chunks: chunksResult.rows.map((chunk) => ({
      chunkIndex: Number(chunk.chunk_index),
      sizeBytes: Number(chunk.size_bytes),
    })),
  });
  if (!validation.ok) {
    throw new Error(`Upload is incomplete: ${validation.error}`);
  }

  const expectedBytes = Number(session.size_bytes);
  const buffer = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;
  for (const chunk of chunksResult.rows) {
    const chunkBuffer = await readFile(chunk.storage_path);
    const declaredSize = Number(chunk.size_bytes);
    if (chunkBuffer.length !== declaredSize) {
      throw new Error(
        `Upload chunk ${chunk.chunk_index} size mismatch: expected ${declaredSize}, got ${chunkBuffer.length}`,
      );
    }
    chunkBuffer.copy(buffer, offset);
    offset += chunkBuffer.length;
  }
  if (offset !== expectedBytes) {
    throw new Error(`Upload size mismatch: expected ${expectedBytes}, got ${offset}`);
  }

  return { session, buffer };
}

export function arrayBufferFromBuffer(buffer: Buffer): ArrayBuffer {
  if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
    return buffer.buffer as ArrayBuffer;
  }
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

async function lockImageSeriesAppend(pool: pg.Pool, bookId: string): Promise<pg.PoolClient> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(hashtextextended($1, 7319))', [bookId]);
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function unlockImageSeriesAppend(client: pg.PoolClient, bookId: string): Promise<void> {
  try {
    await client.query('select pg_advisory_unlock(hashtextextended($1, 7319))', [bookId]);
  } finally {
    client.release();
  }
}

async function loadImageSeriesAppendBase(
  queryable: Queryable,
  userId: string,
  bookId: string,
): Promise<ImageSeriesAppendBaseRow> {
  const result = await queryable.query<ImageSeriesAppendBaseRow>(
    `select book.id, book.format, book.active_content_revision_id, book.source_file_name,
            object.storage_key, object.content_type, object.raw_text_hash, book.total_chapters
       from library_books book
       join book_objects object on object.id = book.object_id
      where book.id = $1 and book.user_id = $2 and book.deleted_at is null`,
    [bookId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('회차를 추가할 기존 만화 작품이나 원본을 찾지 못했습니다.');
  if (row.format !== 'image_archive') throw new Error('만화 작품에만 회차 delta를 추가할 수 있습니다.');
  if (!row.active_content_revision_id) throw new Error('기존 만화 작품의 활성 본문 revision을 찾지 못했습니다.');
  return row;
}

async function finalizeNoopImageSeriesAppend(
  client: pg.PoolClient,
  input: {
    readonly uploadId: string;
    readonly jobId: string;
    readonly bookId: string;
    readonly userId: string;
    readonly expectedContentRevisionId: string;
    readonly bytesRead: number;
    readonly totalBytes: number;
    readonly totalChapters: number;
    readonly attempt: ImportExecutionAttempt;
  },
): Promise<void> {
  await client.query('begin');
  try {
    const current = await client.query<{ active_content_revision_id: string }>(
      `select active_content_revision_id from library_books
        where id = $1 and user_id = $2 and active_content_revision_id = $3
        for update`,
      [input.bookId, input.userId, input.expectedContentRevisionId],
    );
    if (!current.rows[0]) throw new Error('image_series_append_base_changed');
    const activatedUpload = await client.query(
      `update upload_sessions set status = 'imported', updated_at = now()
        where id = $1 and status = 'queued'
          and exists (
            select 1 from import_jobs
             where id = $2 and status = 'processing' and cancel_requested_at is null
               ${input.attempt.executionId ? 'and active_queue_job_id = $3' : ''}
          )
        returning id`,
      input.attempt.executionId
        ? [input.uploadId, input.jobId, input.attempt.executionId]
        : [input.uploadId, input.jobId],
    );
    if (activatedUpload.rowCount === 0) throw new ImportExecutionStoppedError('cancelled');
    await client.query('delete from upload_chunks where upload_id = $1', [input.uploadId]);
    const finalized = await updateImportJobProgress(
      client,
      input.jobId,
      {
        status: 'done',
        stage: 'ready',
        bytesRead: input.bytesRead,
        totalBytes: input.totalBytes,
        chaptersDetected: input.totalChapters,
        paragraphsWritten: 0,
        message: '이미 반영된 회차입니다.',
        bookId: input.bookId,
        errorMessage: null,
      },
      input.attempt.executionId,
    );
    if (input.attempt.executionId && !finalized) throw new ImportExecutionStoppedError('cancelled');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

export async function processImportJob(
  pool: pg.Pool,
  config: ServerConfig,
  jobId: string,
  uploadId: string,
  attempt: ImportExecutionAttempt = SINGLE_IMPORT_ATTEMPT,
  logger?: Pick<StructuredLogger, 'info'>,
): Promise<void> {
  if (!(await claimImportExecution(pool, jobId, attempt.executionId))) return;
  const measurements = new ImportMeasurements(logger, jobId);
  if (!attempt.executionId) {
    await updateImportJobProgress(pool, jobId, {
      status: 'processing',
      stage: 'reading',
      message: '업로드 조각을 검증하고 조립하는 중입니다.',
      errorMessage: null,
    });
  }

  const importAbort = new AbortController();
  const heartbeat = setInterval(() => {
    void pool
      .query(
        `update import_jobs set updated_at = now()
          where id = $1 and status = 'processing'${attempt.executionId ? ' and active_queue_job_id = $2 and cancel_requested_at is null' : ''}`,
        attempt.executionId ? [jobId, attempt.executionId] : [jobId],
      )
      .then((result) => {
        if (attempt.executionId && (result.rowCount ?? 0) === 0) importAbort.abort();
      })
      .catch(() => undefined);
  }, IMPORT_JOB_HEARTBEAT_MS);
  heartbeat.unref();

  const uploadedObjectKeys: string[] = [];
  let importCommitted = false;
  let appendNoop = false;
  let appendLockClient: pg.PoolClient | undefined;
  let appendLockBookId: string | undefined;
  try {
    await assertImportExecutionActive(pool, jobId, attempt.executionId);
    const { session, buffer: uploadBuffer } = await readUploadBuffer(pool, uploadId);
    const expectedBase = parseImportExpectedBase(session.expected_base);
    if (expectedBase && (!session.client_book_id || session.import_mode === 'append_image_series')) {
      throw new Error('invalid_import_expected_base');
    }
    let buffer: Buffer | undefined = uploadBuffer;
    const bytesRead = buffer.length;
    const totalBytes = Number(session.size_bytes);
    measurements.counts.uploadBytes = bytesRead;
    const uploadedSourceContentHash = integrityHash(buffer);
    if (session.source_content_hash && uploadedSourceContentHash !== session.source_content_hash) {
      throw new Error('Uploaded source bytes do not match sourceContentHash');
    }
    let sourceContentHash = uploadedSourceContentHash;
    let canonicalFileName = session.file_name;
    let canonicalContentType = session.content_type;
    let appendBaseContentRevisionId: string | undefined;
    let appendNoopTotalChapters = 0;
    const importMode = session.import_mode ?? 'replace_book';
    const incrementalImageSeriesAppend = importMode === 'append_image_series';
    let comicPlan: ComicSourceAppendPlan | undefined;
    let preparedComic: ParsedNovelImport | undefined;
    const comicPagePartsToRead = new Map<string, Blob>();
    const comicPageIdsToRead = new Set<string>();
    measurements.counts.incrementalAppend = incrementalImageSeriesAppend;
    if (incrementalImageSeriesAppend) {
      const bookId = session.client_book_id?.trim();
      if (!bookId) throw new Error('회차 delta에 대상 만화 작품 ID가 없습니다.');
      appendLockBookId = bookId;
      measurements.start('append_lock');
      appendLockClient = await lockImageSeriesAppend(pool, bookId);
      measurements.start('base_read_merge');
      await assertImportExecutionActive(pool, jobId, attempt.executionId);
      const appendBase = await loadImageSeriesAppendBase(appendLockClient, session.user_id, bookId);
      appendBaseContentRevisionId = appendBase.active_content_revision_id;
      appendNoopTotalChapters = Number(appendBase.total_chapters);
      const s3Client = createS3Client(config);
      const existingObject = await getObjectBuffer(s3Client, config, appendBase.storage_key);
      measurements.counts.baseBytes = existingObject.body.length;
      const existingAssets = await appendLockClient.query<{
        id: string;
        kind: string;
        content_hash: string;
        page_index: number | null;
      }>(
        "select id, kind, content_hash, page_index from book_assets where user_id = $1 and book_id = $2 and status = 'active' and kind in ('document_page', 'source_part')",
        [session.user_id, bookId],
      );
      const merged = await planComicSourceAppend({
        existingSource: new Blob([arrayBufferFromBuffer(existingObject.body)], {
          type: appendBase.content_type || 'application/vnd.comicbook+zip',
        }),
        existingSourceHash: appendBase.raw_text_hash,
        delta: new Blob([arrayBufferFromBuffer(buffer)], {
          type: session.content_type || 'application/vnd.comicbook+zip',
        }),
        deltaHash: uploadedSourceContentHash,
        bookId,
        signal: importAbort.signal,
        existingAssets: existingAssets.rows.map((asset) => ({
          ...asset,
          contentHash: asset.content_hash,
          pageIndex: asset.page_index ?? undefined,
        })),
      });
      if (
        session.base_active_content_revision_id !== appendBaseContentRevisionId &&
        merged.replacedSectionIds.length > 0
      ) {
        throw new Error('image_series_append_base_changed');
      }
      if (merged.changedSectionIds.length === 0) {
        appendNoop = true;
        measurements.start('commit_database');
        await finalizeNoopImageSeriesAppend(appendLockClient, {
          uploadId,
          jobId,
          bookId,
          userId: session.user_id,
          expectedContentRevisionId: appendBaseContentRevisionId,
          bytesRead,
          totalBytes,
          totalChapters: appendNoopTotalChapters,
          attempt,
        });
        importCommitted = true;
        measurements.start('cleanup');
        await removeUploadDirectory(config, uploadId);
        return;
      }
      comicPlan = merged;
      canonicalFileName = appendBase.source_file_name || session.file_name;
      for (const [hash, blob] of merged.newParts)
        if (hash !== appendBase.raw_text_hash) comicPagePartsToRead.set(hash, blob);
      merged.manifest.sourcePages
        .filter((page) => comicPagePartsToRead.has(page.partHash))
        .forEach((page) => comicPageIdsToRead.add(comicPageAssetId(bookId, page)));
      preparedComic = await materializeComicSource({
        manifest: merged.manifest,
        sourceContentHash: merged.sourceContentHash,
        fileName: canonicalFileName,
        bookId,
        // First conversion stores the already-read legacy CBZ as an attempt-owned part.
        // Its shared book_objects key can be replaced and collected by another import.
        // Later appends only contain the new parts; existing pages still stay untouched.
        partsToStore: merged.newParts,
        pagePartsToRead: comicPagePartsToRead,
        pageAssetIdsToRead: comicPageIdsToRead,
        pageAssetIds: merged.pageAssetIds,
        signal: importAbort.signal,
      });
      buffer = Buffer.from(await merged.source.arrayBuffer());
      sourceContentHash = merged.sourceContentHash;
      canonicalContentType = COMIC_SOURCE_CONTENT_TYPE;
      await updateImportJobProgress(
        pool,
        jobId,
        {
          status: 'processing',
          stage: 'decoding',
          bytesRead,
          totalBytes,
          message: `${merged.changedSectionIds.length.toLocaleString()}개 회차를 기존 작품에 반영하는 중입니다.`,
        },
        attempt.executionId,
      );
    }
    await updateImportJobProgress(
      pool,
      jobId,
      {
        status: 'processing',
        stage: 'decoding',
        bytesRead,
        totalBytes,
        message: '인코딩을 해석하고 본문을 정리하는 중입니다.',
      },
      attempt.executionId,
    );
    await assertImportExecutionActive(pool, jobId, attempt.executionId);
    measurements.start('parse_archive');
    let arrayBuffer: ArrayBuffer | undefined = arrayBufferFromBuffer(buffer);
    let parsed: ParsedNovelImport;
    let sourceBlob = new Blob([arrayBuffer]);
    const comicPackage =
      !preparedComic && /\.(zip|cbz)$/i.test(canonicalFileName) ? await unpackComicSource(sourceBlob) : undefined;
    if (comicPackage) {
      sourceBlob = comicPackage.source;
      buffer = Buffer.from(await sourceBlob.arrayBuffer());
      sourceContentHash = integrityHash(buffer);
      canonicalContentType = COMIC_SOURCE_CONTENT_TYPE;
      preparedComic = await materializeComicSource({
        manifest: comicPackage.manifest,
        sourceContentHash,
        fileName: canonicalFileName,
        bookId: session.client_book_id?.trim() || persistentId128('comic_book', [sourceContentHash]),
        partsToStore: comicPackage.parts,
        pagePartsToRead: comicPackage.parts,
        signal: importAbort.signal,
      });
    }
    if (preparedComic) {
      parsed = preparedComic;
    } else if (/\.zip$/i.test(canonicalFileName) && (await hasDocumentSeriesManifest(sourceBlob))) {
      parsed = await materializeDocumentSeriesArchive(sourceBlob, {
        fileName: canonicalFileName,
        clientBookId: session.client_book_id ?? undefined,
        sourceContentHash,
      });
    } else if (/\.epub$/i.test(canonicalFileName)) {
      parsed = materializeEpubImport(await parseEpub(new Blob([arrayBuffer], { type: 'application/epub+zip' })), {
        fileName: canonicalFileName,
        sourceBytes: new Uint8Array(arrayBuffer),
        clientBookId: session.client_book_id ?? undefined,
      });
    } else if (/\.pdf$/i.test(canonicalFileName)) {
      parsed = await materializePdfImport({
        fileName: canonicalFileName,
        sourceBytes: new Uint8Array(arrayBuffer),
        clientBookId: session.client_book_id ?? undefined,
      });
    } else if (/\.(zip|cbz|rar|cbr|7z|cb7)$/i.test(canonicalFileName)) {
      const document = await openImageArchiveStream(new Blob([arrayBuffer]), { fileName: canonicalFileName });
      parsed = materializeStreamingImageArchiveImport({
        fileName: canonicalFileName,
        sourceContentHash,
        document,
        clientBookId: session.client_book_id ?? undefined,
      });
    } else {
      parsed = rekeyParsedNovelImport(
        await parseNovelFileForImport(canonicalFileName, arrayBuffer, session.encoding, {
          chapterSplitMode: session.chapter_split_mode ?? 'auto',
        }),
        session.client_book_id,
      );
    }
    arrayBuffer = undefined;
    measurements.counts.pageCount =
      parsed.novel.format === 'image_archive' || parsed.novel.format === 'pdf' ? parsed.chapters.length : 0;
    await updateImportJobProgress(
      pool,
      jobId,
      {
        status: 'processing',
        stage: 'writing',
        bytesRead,
        totalBytes,
        chaptersDetected: parsed.chapters.length,
        paragraphsWritten: 0,
        message: '화와 문단을 저장하는 중입니다.',
      },
      attempt.executionId,
    );
    const rawHash = parsed.novel.rawTextHash;
    const objectId = persistentId128('object', [rawHash]);
    const storageKey = `${session.user_id}/sources/${objectId}/${jobId}/${attempt.executionId ?? randomUUID()}/attempt-${attempt.attemptNumber}/${canonicalFileName}`;
    const s3Client = createS3Client(config);
    const canonicalSizeBytes = buffer.length;
    measurements.counts.canonicalBytes = canonicalSizeBytes;
    measurements.start('write_source');

    await assertImportExecutionActive(pool, jobId, attempt.executionId);
    await reserveObjectDeletions(pool, [storageKey], 'import_source_staging');
    await putRawBookObject(s3Client, config, storageKey, buffer, canonicalContentType);
    uploadedObjectKeys.push(storageKey);
    buffer = undefined;
    measurements.start('write_assets');
    const reusePage =
      incrementalImageSeriesAppend && appendLockClient
        ? await loadImportPageReuse(appendLockClient, session.user_id, parsed.novel.id, (key) =>
            inspectStoredObject(s3Client, config, key),
          )
        : undefined;
    const storedAssets: Array<Omit<ParsedNovelImportAsset, 'bytes'> & { byteLength: number; storageKey: string }> = [];
    if (comicPlan && appendLockClient) {
      const retained = await retainComicAssets({
        client: appendLockClient,
        userId: session.user_id,
        bookId: parsed.novel.id,
        plan: comicPlan,
        pageParts: comicPagePartsToRead,
        pageIds: comicPageIdsToRead,
        inspect: (key) => inspectStoredObject(s3Client, config, key),
        read: async (key) => new Blob([arrayBufferFromBuffer((await getObjectBuffer(s3Client, config, key)).body)]),
      });
      storedAssets.push(...retained);
      measurements.counts.reusedPages += retained.filter((asset) => asset.kind === 'document_page').length;
      measurements.counts.reusedPageBytes += retained
        .filter((asset) => asset.kind === 'document_page')
        .reduce((sum, asset) => sum + asset.byteLength, 0);
    }
    const eagerAssets = (parsed.embeddedAssets ?? []).map((asset) => ({
      asset,
      storageKey: `${session.user_id}/${parsed.novel.id}/staged/${jobId}/${attempt.executionId ?? 'legacy'}/attempt-${attempt.attemptNumber}/${asset.id}/${asset.fileName}`,
    }));
    if (eagerAssets.length > 0) {
      await reserveObjectDeletions(
        pool,
        eagerAssets.map((entry) => entry.storageKey),
        'import_asset_staging',
      );
      let completedAssets = 0;
      for (const assetBatch of chunked(eagerAssets, SERVER_IMPORT_EAGER_ASSET_CONCURRENCY)) {
        await assertImportExecutionActive(pool, jobId, attempt.executionId);
        const outcomes = await Promise.allSettled(
          assetBatch.map(async ({ asset, storageKey: assetStorageKey }) => {
            await putRawBookObject(s3Client, config, assetStorageKey, Buffer.from(asset.bytes), asset.contentType);
            uploadedObjectKeys.push(assetStorageKey);
            const { bytes: _releasedBytes, ...metadata } = asset;
            return { ...metadata, byteLength: asset.bytes.byteLength, storageKey: assetStorageKey };
          }),
        );
        const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
        if (failed) throw failed.reason;
        storedAssets.push(
          ...outcomes
            .filter(
              (outcome): outcome is PromiseFulfilledResult<(typeof storedAssets)[number]> =>
                outcome.status === 'fulfilled',
            )
            .map((outcome) => outcome.value),
        );
        completedAssets += assetBatch.length;
        await updateImportJobProgress(
          pool,
          jobId,
          {
            status: 'processing',
            stage: 'writing',
            message: `EPUB 삽화와 표지를 저장하는 중입니다. ${completedAssets.toLocaleString()} / ${eagerAssets.length.toLocaleString()}개`,
          },
          attempt.executionId,
        );
      }
    }
    if (parsed.consumeEmbeddedAssets) {
      let streamedAssets = 0;
      let assetBatch: Array<{ asset: ParsedNovelImportAsset; storageKey: string }> = [];
      const flushAssetBatch = async () => {
        if (assetBatch.length === 0) return;
        const pendingBatch = assetBatch;
        assetBatch = [];
        await assertImportExecutionActive(pool, jobId, attempt.executionId);
        const currentBatch = await Promise.all(
          pendingBatch.map(async (entry) => {
            const existingKey = await reusePage?.(entry.asset);
            return { ...entry, storageKey: existingKey ?? entry.storageKey, reused: existingKey !== undefined };
          }),
        );
        await reserveObjectDeletions(
          pool,
          currentBatch.filter((entry) => !entry.reused).map((entry) => entry.storageKey),
          'import_asset_staging',
        );
        const outcomes = await Promise.allSettled(
          currentBatch.map(async ({ asset, storageKey: assetStorageKey, reused }) => {
            if (!reused) {
              await putRawBookObject(s3Client, config, assetStorageKey, Buffer.from(asset.bytes), asset.contentType);
              // Only newly written objects belong to this attempt's failure cleanup.
              uploadedObjectKeys.push(assetStorageKey);
            }
            if (asset.kind === 'document_page') {
              if (reused) {
                measurements.counts.reusedPages += 1;
                measurements.counts.reusedPageBytes += asset.bytes.byteLength;
              } else {
                measurements.counts.writtenPages += 1;
                measurements.counts.writtenPageBytes += asset.bytes.byteLength;
              }
            }
            const { bytes: _releasedBytes, ...metadata } = asset;
            return { ...metadata, byteLength: asset.bytes.byteLength, storageKey: assetStorageKey };
          }),
        );
        const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
        if (failed) throw failed.reason;
        storedAssets.push(
          ...outcomes
            .filter(
              (outcome): outcome is PromiseFulfilledResult<(typeof storedAssets)[number]> =>
                outcome.status === 'fulfilled',
            )
            .map((outcome) => outcome.value),
        );
        streamedAssets += currentBatch.length;
        if (streamedAssets % 8 === 0) {
          await updateImportJobProgress(
            pool,
            jobId,
            {
              status: 'processing',
              stage: 'writing',
              message: `문서 페이지 리소스를 저장하는 중입니다. ${streamedAssets.toLocaleString()}개`,
            },
            attempt.executionId,
          );
        }
      };
      for await (const asset of parsed.consumeEmbeddedAssets()) {
        await assertImportExecutionActive(pool, jobId, attempt.executionId);
        const assetStorageKey = `${session.user_id}/${parsed.novel.id}/staged/${jobId}/${attempt.executionId ?? 'legacy'}/attempt-${attempt.attemptNumber}/${asset.id}/${asset.fileName}`;
        assetBatch.push({ asset, storageKey: assetStorageKey });
        if (assetBatch.length >= SERVER_IMPORT_EAGER_ASSET_CONCURRENCY) await flushAssetBatch();
      }
      await flushAssetBatch();
      if (streamedAssets > 0 && streamedAssets % 8 !== 0) {
        await updateImportJobProgress(
          pool,
          jobId,
          {
            status: 'processing',
            stage: 'writing',
            message: `문서 페이지 리소스를 저장하는 중입니다. ${streamedAssets.toLocaleString()}개`,
          },
          attempt.executionId,
        );
      }
    }
    arrayBuffer = undefined;
    await assertImportExecutionActive(pool, jobId, attempt.executionId);

    measurements.start('commit_database');
    const client = appendLockClient ?? (await pool.connect());
    const releaseTransactionClient = client !== appendLockClient;
    try {
      await client.query('begin');
      await assertImportExpectedBase(client, { bookId: parsed.novel.id, userId: session.user_id, expectedBase });
      if (appendBaseContentRevisionId) {
        const currentBase = await client.query<{ id: string }>(
          `select id from library_books
            where id = $1 and user_id = $2 and active_content_revision_id = $3 and deleted_at is null
            for update`,
          [parsed.novel.id, session.user_id, appendBaseContentRevisionId],
        );
        if (!currentBase.rows[0]) throw new Error('image_series_append_base_changed');
      }
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [rawHash]);
      const previousSource = await client.query<{ storage_key: string }>(
        'select storage_key from book_objects where raw_text_hash = $1 for update',
        [rawHash],
      );
      const obsoleteSourceKeys = previousSource.rows.map((row) => row.storage_key).filter((key) => key !== storageKey);
      await client.query(
        `
          insert into book_objects (id, raw_text_hash, storage_key, file_name, content_type, size_bytes)
          values ($1, $2, $3, $4, $5, $6)
          on conflict (raw_text_hash) do update
            set storage_key = excluded.storage_key,
                file_name = excluded.file_name,
                content_type = excluded.content_type,
                size_bytes = excluded.size_bytes
        `,
        [objectId, rawHash, storageKey, canonicalFileName, canonicalContentType, canonicalSizeBytes],
      );
      const previousBookObject = await client.query<{ object_id?: string | null }>(
        'select object_id from library_books where id = $1 and user_id = $2',
        [parsed.novel.id, session.user_id],
      );
      const replacement = await prepareBookReplacement(client, {
        userId: session.user_id,
        bookId: parsed.novel.id,
        sourceObjectId: objectId,
        sourceRawTextHash: rawHash,
        normalizedTextHash: parsed.novel.normalizedTextHash,
        sourceFileName: parsed.novel.sourceFileName,
        sourceEncoding: parsed.novel.sourceEncoding,
      });
      const activatedBook = await client.query(
        `
          insert into library_books (
            id, user_id, object_id, format, title, author, description, language, source_file_name, source_encoding,
            normalized_text_hash, total_chapters, total_characters, total_paragraphs, cover_seed, favorite,
            document_section_count, created_at, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, false, $16, $17, $18)
          on conflict (id) do update
            set object_id = excluded.object_id,
                format = excluded.format,
                source_file_name = excluded.source_file_name,
                source_encoding = excluded.source_encoding,
                normalized_text_hash = excluded.normalized_text_hash,
                total_chapters = excluded.total_chapters,
                total_characters = excluded.total_characters,
                total_paragraphs = excluded.total_paragraphs,
                cover_seed = case
                  when $19::text = 'append_image_series' then library_books.cover_seed
                  else excluded.cover_seed
                end,
                document_section_count = excluded.document_section_count,
                deleted_at = null,
                deleted_by_device_id = null,
                metadata_revision = case
                  when $19::text = 'append_image_series' then library_books.metadata_revision
                  else library_books.metadata_revision + 1
                end,
                updated_at = excluded.updated_at
          where $20::text is null or (
            $20::text = 'revision' and library_books.user_id = excluded.user_id and
            library_books.active_content_revision_id = $21::text
          )
        `,
        [
          parsed.novel.id,
          session.user_id,
          objectId,
          parsed.novel.format ?? 'txt',
          parsed.novel.title,
          parsed.novel.author ?? null,
          parsed.novel.description ?? null,
          parsed.novel.language ?? null,
          parsed.novel.sourceFileName,
          parsed.novel.sourceEncoding,
          parsed.novel.normalizedTextHash,
          parsed.novel.totalChapters,
          parsed.novel.totalCharacters,
          parsed.novel.totalParagraphs,
          normalizeCoverSeedForPersistence(parsed.novel.coverSeed),
          parsed.novel.documentSectionCount ?? null,
          parsed.novel.createdAt,
          parsed.novel.updatedAt,
          importMode,
          expectedBase?.kind ?? null,
          expectedBase?.kind === 'revision' ? expectedBase.contentRevisionId : null,
        ],
      );
      if (expectedBase && activatedBook.rowCount === 0) throw new Error('import_expected_base_conflict');
      if (previousBookObject.rows[0]?.object_id && previousBookObject.rows[0].object_id !== objectId) {
        const orphanedSource = await client.query<{ storage_key: string }>(
          `delete from book_objects object
            where object.id = $1
              and not exists (select 1 from library_books book where book.object_id = object.id)
            returning object.storage_key`,
          [previousBookObject.rows[0].object_id],
        );
        obsoleteSourceKeys.push(...orphanedSource.rows.map((row) => row.storage_key));
      }
      const activeCover = await client.query<{ id: string | null; provenance: string | null }>(
        `select asset.id, asset.provenance
           from library_books book
           left join book_assets asset on asset.id = book.cover_asset_id
          where book.id = $1 and book.user_id = $2`,
        [parsed.novel.id, session.user_id],
      );
      const preserveExistingCover =
        (incrementalImageSeriesAppend && Boolean(activeCover.rows[0]?.id)) ||
        activeCover.rows[0]?.provenance === 'user_supplied' ||
        activeCover.rows[0]?.provenance === 'approved_enrichment';
      const removedAssets = await client.query<{ storage_key: string }>(
        `delete from book_assets
          where book_id = $1 and user_id = $2 and kind in ('epub_resource', 'document_page', 'source_part') and status = 'active'
            and not (id = any($3::text[]))
          returning storage_key`,
        [
          parsed.novel.id,
          session.user_id,
          storedAssets
            .filter(
              (asset) =>
                asset.kind === 'epub_resource' || asset.kind === 'document_page' || asset.kind === 'source_part',
            )
            .map((asset) => asset.id),
        ],
      );
      const replacedAssetIds = storedAssets.map((asset) => asset.id);
      const replacedAssets = replacedAssetIds.length
        ? await client.query<{ id: string; storage_key: string }>(
            'select id, storage_key from book_assets where id = any($1::text[])',
            [replacedAssetIds],
          )
        : { rows: [] as Array<{ id: string; storage_key: string }> };
      const nextStorageById = new Map(storedAssets.map((asset) => [asset.id, asset.storageKey]));
      const obsoleteAssetKeys = [
        ...obsoleteSourceKeys,
        ...removedAssets.rows.map((row) => row.storage_key),
        ...replacedAssets.rows
          .filter((row) => nextStorageById.get(row.id) !== row.storage_key)
          .map((row) => row.storage_key),
      ];
      if (!preserveExistingCover) {
        const removedCovers = await client.query<{ storage_key: string }>(
          `delete from book_assets
            where book_id = $1 and user_id = $2 and kind = 'cover' and status = 'active'
            returning storage_key`,
          [parsed.novel.id, session.user_id],
        );
        obsoleteAssetKeys.push(...removedCovers.rows.map((row) => row.storage_key));
      }
      const staleAssets = await client.query<{ storage_key: string }>(
        `delete from book_assets
          where book_id = $1 and user_id = $2 and status = 'superseded' and kind <> 'cover'
          returning storage_key`,
        [parsed.novel.id, session.user_id],
      );
      obsoleteAssetKeys.push(...staleAssets.rows.map((row) => row.storage_key));
      const assetsToActivate = storedAssets.filter((asset) => !(asset.kind === 'cover' && preserveExistingCover));
      obsoleteAssetKeys.push(
        ...storedAssets
          .filter((asset) => asset.kind === 'cover' && preserveExistingCover)
          .map((asset) => asset.storageKey),
      );
      for (const asset of assetsToActivate) {
        await client.query(
          `insert into book_assets (
             id, user_id, book_id, content_revision_id, kind, provenance, status, storage_key, file_name,
             content_type, byte_length, content_hash, page_index, created_at, activated_at
           ) values ($1, $2, $3, null, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())
           on conflict (id) do update set
             status = excluded.status, storage_key = excluded.storage_key, file_name = excluded.file_name,
             provenance = excluded.provenance, content_type = excluded.content_type,
             byte_length = excluded.byte_length, content_hash = excluded.content_hash,
             page_index = excluded.page_index, activated_at = now()`,
          [
            asset.id,
            session.user_id,
            parsed.novel.id,
            asset.kind,
            asset.provenance,
            'active',
            asset.storageKey,
            asset.fileName,
            asset.contentType,
            asset.byteLength,
            asset.contentHash,
            asset.pageIndex ?? null,
          ],
        );
      }
      const cover = assetsToActivate.find((asset) => asset.kind === 'cover');
      if (cover && !preserveExistingCover) {
        await client.query(
          `update library_books set cover_asset_id = $1, cover_fit = 'contain', cover_position_x = 50,
             cover_position_y = 50 where id = $2 and user_id = $3`,
          [cover.id, parsed.novel.id, session.user_id],
        );
      }
      await replaceParsedBookContent(client, parsed.novel.id);
      for (const chapterBatch of chunked(parsed.chapters, SERVER_IMPORT_CHAPTER_BATCH_SIZE)) {
        await insertChapterBatch(client, chapterBatch);
      }
      let paragraphsWritten = 0;
      const shouldUpdateParagraphProgress = createImportProgressUpdateThrottle();
      for await (const pageBatch of iterateImportParagraphPageBatchesAsync(parsed, SERVER_IMPORT_PAGE_BATCH_SIZE)) {
        paragraphsWritten += await insertParagraphPageBatch(client, pageBatch);
        if (!shouldUpdateParagraphProgress()) continue;
        const progressUpdated = await updateImportJobProgress(
          pool,
          jobId,
          {
            status: 'processing',
            stage: 'writing',
            chaptersDetected: parsed.chapters.length,
            paragraphsWritten,
            message: `화와 문단을 저장하는 중입니다. ${paragraphsWritten.toLocaleString()} / ${parsed.novel.totalParagraphs.toLocaleString()} 문단`,
          },
          attempt.executionId,
        );
        if (attempt.executionId && !progressUpdated) throw new ImportExecutionStoppedError('cancelled');
      }
      if (
        replacement &&
        ((parsed.novel.format === 'image_archive' && parsed.novel.documentSectionCount) ||
          isRemoteDocumentSeriesImport(parsed))
      ) {
        await restoreExactAnchoredReaderState(client, replacement);
      }
      if (replacement) await finalizeBookReplacement(client, replacement);
      const importPayload = { bookId: parsed.novel.id };
      const importRevision = {
        entityType: 'book',
        entityId: parsed.novel.id,
        novelId: parsed.novel.id,
        localSequence: 0,
        updatedAt: parsed.novel.updatedAt,
        payloadHash: integrityHash(JSON.stringify(importPayload)),
      };
      await client.query(
        `
          insert into sync_events (id, user_id, type, book_id, entity_id, payload, revision, created_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8)
          on conflict (id) do nothing
        `,
        [
          persistentId128('sync_event', [session.user_id, 'book_imported', parsed.novel.id, parsed.novel.updatedAt]),
          session.user_id,
          'book_imported',
          parsed.novel.id,
          parsed.novel.id,
          JSON.stringify(importPayload),
          JSON.stringify(importRevision),
          parsed.novel.updatedAt,
        ],
      );
      const activatedUpload = await client.query(
        `update upload_sessions set status = 'imported', updated_at = now()
          where id = $1 and status = 'queued'
            and exists (
              select 1 from import_jobs
               where id = $2 and status = 'processing' and cancel_requested_at is null
                 ${attempt.executionId ? 'and active_queue_job_id = $3' : ''}
            )
          returning id`,
        attempt.executionId ? [uploadId, jobId, attempt.executionId] : [uploadId, jobId],
      );
      if (activatedUpload.rowCount === 0) {
        throw new ImportExecutionStoppedError('cancelled');
      }
      await client.query('delete from upload_chunks where upload_id = $1', [uploadId]);
      const finalized = await updateImportJobProgress(
        client,
        jobId,
        {
          status: 'done',
          stage: 'ready',
          bytesRead,
          totalBytes,
          chaptersDetected: parsed.chapters.length,
          paragraphsWritten: parsed.novel.totalParagraphs,
          message: '서버 가져오기가 완료되었습니다.',
          bookId: parsed.novel.id,
          errorMessage: null,
        },
        attempt.executionId,
      );
      if (attempt.executionId && !finalized) throw new ImportExecutionStoppedError('cancelled');
      await releaseObjectDeletionReservations(client, uploadedObjectKeys);
      // New asset ids can still point to an old immutable object. Preserve those
      // references atomically; never queue a reused page for replacement cleanup.
      const retainedAssetKeys = new Set(assetsToActivate.map((asset) => asset.storageKey));
      await enqueueObjectDeletions(
        client,
        obsoleteAssetKeys.filter((key) => !retainedAssetKeys.has(key)),
        'replaced_import_object',
      );
      await client.query('commit');
      importCommitted = true;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      if (releaseTransactionClient) client.release();
    }
    measurements.start('cleanup');
    if (importCommitted) await removeUploadDirectory(config, uploadId);
  } catch (error) {
    if (!importCommitted && uploadedObjectKeys.length) {
      await enqueueObjectDeletions(pool, uploadedObjectKeys, 'abandoned_import_object').catch(() => undefined);
    }
    let stopped = error instanceof ImportExecutionStoppedError ? error : undefined;
    if (!stopped && attempt.executionId) {
      try {
        await assertImportExecutionActive(pool, jobId, attempt.executionId);
      } catch (executionError) {
        if (executionError instanceof ImportExecutionStoppedError) stopped = executionError;
      }
    }
    if (stopped) {
      if (stopped.reason === 'cancelled') {
        await pool.query('delete from upload_chunks where upload_id = $1', [uploadId]).catch(() => undefined);
        await removeUploadDirectory(config, uploadId);
      }
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (attempt.finalAttempt) {
      await pool.query(
        "update upload_sessions set status = 'failed', updated_at = now() where id = $1 and status not in ('imported', 'cancelled')",
        [uploadId],
      );
      await updateImportJobProgress(
        pool,
        jobId,
        {
          status: 'failed',
          stage: 'failed',
          message: '서버 가져오기에 실패했습니다.',
          errorMessage: message,
        },
        attempt.executionId,
      );
    } else {
      await updateImportJobProgress(
        pool,
        jobId,
        {
          status: 'queued',
          stage: 'queued',
          message: `서버 가져오기를 재시도합니다. (${attempt.attemptNumber}/${attempt.maxAttempts} 실패)`,
          errorMessage: message,
        },
        attempt.executionId,
      );
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    measurements.finish(importCommitted ? (appendNoop ? 'noop' : 'committed') : 'not_committed');
    if (appendLockClient && appendLockBookId) {
      await unlockImageSeriesAppend(appendLockClient, appendLockBookId).catch(() => undefined);
    }
  }
}
