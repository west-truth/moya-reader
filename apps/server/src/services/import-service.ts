import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ServerConfig } from '../config.js';
import { createS3Client, putRawBookObject } from './object-storage.js';
import { parseNovelFileForImport } from '@noveldesk/text-core/parser';
import { materializeEpubImport, parseEpub } from '@noveldesk/epub-core';
import { hasDocumentSeriesManifest, materializeDocumentSeriesArchive } from '@noveldesk/document-series-core';
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
import { finalizeBookReplacement, prepareBookReplacement } from './book-revision/service.js';
import {
  enqueueObjectDeletions,
  releaseObjectDeletionReservations,
  reserveObjectDeletions,
} from './object-delete-outbox.js';

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
      chapter.createdAt,
      chapter.updatedAt,
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11})`;
  });

  await client.query(
    `
      insert into chapters (
        id, book_id, chapter_index, title, text_hash, raw_start_offset, raw_end_offset,
        character_count, paragraph_count, created_at, updated_at
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

async function insertParagraphSearchBatch(client: pg.PoolClient, pages: ParagraphPage[]): Promise<void> {
  const paragraphs = pages.flatMap((page) =>
    page.paragraphs.map((paragraph) => ({
      page,
      paragraph,
    })),
  );
  if (!paragraphs.length) return;

  const values: unknown[] = [];
  const rows = paragraphs.map(({ page, paragraph }) => {
    const offset = values.length;
    values.push(
      persistentId128('paragraph_search', [page.novelId, page.chapterId, paragraph.id]),
      paragraph.id,
      page.novelId,
      page.chapterId,
      page.pageIndex,
      paragraph.index,
      paragraph.text,
      paragraph.text.toLowerCase(),
      JSON.stringify(paragraph),
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`;
  });

  await client.query(
    `
      insert into paragraph_search (
        id, paragraph_id, book_id, chapter_id, page_index, paragraph_index, text, text_lower, paragraph
      )
      values ${rows.join(', ')}
      on conflict (id) do update
        set paragraph_id = excluded.paragraph_id,
            book_id = excluded.book_id,
            chapter_id = excluded.chapter_id,
            page_index = excluded.page_index,
            paragraph_index = excluded.paragraph_index,
            text = excluded.text,
            text_lower = excluded.text_lower,
            paragraph = excluded.paragraph,
            updated_at = now()
    `,
    values,
  );
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

export async function processImportJob(
  pool: pg.Pool,
  config: ServerConfig,
  jobId: string,
  uploadId: string,
  attempt: ImportExecutionAttempt = SINGLE_IMPORT_ATTEMPT,
): Promise<void> {
  if (!(await claimImportExecution(pool, jobId, attempt.executionId))) return;
  if (!attempt.executionId) {
    await updateImportJobProgress(pool, jobId, {
      status: 'processing',
      stage: 'reading',
      message: '업로드 조각을 검증하고 조립하는 중입니다.',
      errorMessage: null,
    });
  }

  const heartbeat = setInterval(() => {
    void pool
      .query(
        `update import_jobs set updated_at = now()
          where id = $1 and status = 'processing'${attempt.executionId ? ' and active_queue_job_id = $2 and cancel_requested_at is null' : ''}`,
        attempt.executionId ? [jobId, attempt.executionId] : [jobId],
      )
      .catch(() => undefined);
  }, IMPORT_JOB_HEARTBEAT_MS);
  heartbeat.unref();

  const uploadedObjectKeys: string[] = [];
  let importCommitted = false;
  try {
    await assertImportExecutionActive(pool, jobId, attempt.executionId);
    const { session, buffer: uploadBuffer } = await readUploadBuffer(pool, uploadId);
    let buffer: Buffer | undefined = uploadBuffer;
    const bytesRead = buffer.length;
    const totalBytes = Number(session.size_bytes);
    const sourceContentHash = integrityHash(buffer);
    if (session.source_content_hash && sourceContentHash !== session.source_content_hash) {
      throw new Error('Uploaded source bytes do not match sourceContentHash');
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
    let arrayBuffer: ArrayBuffer | undefined = arrayBufferFromBuffer(buffer);
    let parsed: ParsedNovelImport;
    const sourceBlob = new Blob([arrayBuffer]);
    if (/\.zip$/i.test(session.file_name) && (await hasDocumentSeriesManifest(sourceBlob))) {
      parsed = await materializeDocumentSeriesArchive(sourceBlob, {
        fileName: session.file_name,
        clientBookId: session.client_book_id ?? undefined,
        sourceContentHash,
      });
    } else if (/\.epub$/i.test(session.file_name)) {
      parsed = materializeEpubImport(await parseEpub(new Blob([arrayBuffer], { type: 'application/epub+zip' })), {
        fileName: session.file_name,
        sourceBytes: new Uint8Array(arrayBuffer),
        clientBookId: session.client_book_id ?? undefined,
      });
    } else if (/\.pdf$/i.test(session.file_name)) {
      parsed = await materializePdfImport({
        fileName: session.file_name,
        sourceBytes: new Uint8Array(arrayBuffer),
        clientBookId: session.client_book_id ?? undefined,
      });
    } else if (/\.(zip|cbz|rar|cbr|7z|cb7)$/i.test(session.file_name)) {
      const document = await openImageArchiveStream(new Blob([arrayBuffer]), { fileName: session.file_name });
      parsed = materializeStreamingImageArchiveImport({
        fileName: session.file_name,
        sourceContentHash,
        document,
        clientBookId: session.client_book_id ?? undefined,
      });
    } else {
      parsed = rekeyParsedNovelImport(
        await parseNovelFileForImport(session.file_name, arrayBuffer, session.encoding, {
          chapterSplitMode: session.chapter_split_mode ?? 'auto',
        }),
        session.client_book_id,
      );
    }
    arrayBuffer = undefined;
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
    const storageKey = `${session.user_id}/sources/${objectId}/${jobId}/${attempt.executionId ?? randomUUID()}/attempt-${attempt.attemptNumber}/${session.file_name}`;
    const s3Client = createS3Client(config);

    await assertImportExecutionActive(pool, jobId, attempt.executionId);
    await reserveObjectDeletions(pool, [storageKey], 'import_source_staging');
    await putRawBookObject(s3Client, config, storageKey, buffer, session.content_type);
    uploadedObjectKeys.push(storageKey);
    buffer = undefined;
    const storedAssets: Array<Omit<ParsedNovelImportAsset, 'bytes'> & { byteLength: number; storageKey: string }> = [];
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
      for await (const asset of parsed.consumeEmbeddedAssets()) {
        await assertImportExecutionActive(pool, jobId, attempt.executionId);
        const assetStorageKey = `${session.user_id}/${parsed.novel.id}/staged/${jobId}/${attempt.executionId ?? 'legacy'}/attempt-${attempt.attemptNumber}/${asset.id}/${asset.fileName}`;
        await reserveObjectDeletions(pool, [assetStorageKey], 'import_asset_staging');
        await putRawBookObject(s3Client, config, assetStorageKey, Buffer.from(asset.bytes), asset.contentType);
        uploadedObjectKeys.push(assetStorageKey);
        const { bytes: _releasedBytes, ...metadata } = asset;
        storedAssets.push({ ...metadata, byteLength: asset.bytes.byteLength, storageKey: assetStorageKey });
        streamedAssets += 1;
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
      }
    }
    arrayBuffer = undefined;
    await assertImportExecutionActive(pool, jobId, attempt.executionId);

    const client = await pool.connect();
    try {
      await client.query('begin');
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
        [objectId, rawHash, storageKey, session.file_name, session.content_type, Number(session.size_bytes)],
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
      await client.query(
        `
          insert into library_books (
            id, user_id, object_id, format, title, author, description, language, source_file_name, source_encoding,
            normalized_text_hash, total_chapters, total_characters, total_paragraphs, cover_seed, favorite,
            created_at, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, false, $16, $17)
          on conflict (id) do update
            set object_id = excluded.object_id,
                format = excluded.format,
                source_file_name = excluded.source_file_name,
                source_encoding = excluded.source_encoding,
                normalized_text_hash = excluded.normalized_text_hash,
                total_chapters = excluded.total_chapters,
                total_characters = excluded.total_characters,
                total_paragraphs = excluded.total_paragraphs,
                cover_seed = excluded.cover_seed,
                deleted_at = null,
                deleted_by_device_id = null,
                metadata_revision = library_books.metadata_revision + 1,
                updated_at = excluded.updated_at
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
          parsed.novel.createdAt,
          parsed.novel.updatedAt,
        ],
      );
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
      const activeCover = await client.query<{ provenance: string | null }>(
        `select asset.provenance
           from library_books book
           left join book_assets asset on asset.id = book.cover_asset_id
          where book.id = $1 and book.user_id = $2`,
        [parsed.novel.id, session.user_id],
      );
      const preserveUserCover = activeCover.rows[0]?.provenance === 'user_supplied';
      const removedAssets = await client.query<{ storage_key: string }>(
        `delete from book_assets
          where book_id = $1 and user_id = $2 and kind in ('epub_resource', 'document_page') and status = 'active'
            and not (id = any($3::text[]))
          returning storage_key`,
        [
          parsed.novel.id,
          session.user_id,
          storedAssets
            .filter((asset) => asset.kind === 'epub_resource' || asset.kind === 'document_page')
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
      if (!preserveUserCover) {
        const removedCovers = await client.query<{ storage_key: string }>(
          `delete from book_assets
            where book_id = $1 and user_id = $2 and kind = 'cover' and status = 'active'
            returning storage_key`,
          [parsed.novel.id, session.user_id],
        );
        obsoleteAssetKeys.push(...removedCovers.rows.map((row) => row.storage_key));
      }
      const staleAssets = await client.query<{ storage_key: string }>(
        `delete from book_assets where book_id = $1 and user_id = $2 and status = 'superseded'
          returning storage_key`,
        [parsed.novel.id, session.user_id],
      );
      obsoleteAssetKeys.push(...staleAssets.rows.map((row) => row.storage_key));
      const assetsToActivate = storedAssets.filter((asset) => !(asset.kind === 'cover' && preserveUserCover));
      obsoleteAssetKeys.push(
        ...storedAssets.filter((asset) => asset.kind === 'cover' && preserveUserCover).map((asset) => asset.storageKey),
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
      if (cover && !preserveUserCover) {
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
      for await (const pageBatch of iterateImportParagraphPageBatchesAsync(parsed, SERVER_IMPORT_PAGE_BATCH_SIZE)) {
        paragraphsWritten += await insertParagraphPageBatch(client, pageBatch);
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
      await enqueueObjectDeletions(client, obsoleteAssetKeys, 'replaced_import_object');
      await client.query('commit');
      importCommitted = true;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
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
  }
}
