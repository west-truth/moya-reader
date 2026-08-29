import type { Chapter, Novel, Paragraph, ParagraphPage } from '../domain/types';
import {
  READER_SEARCH_CURSOR_SLICE_ROWS,
  READER_SEARCH_MAX_PAGE_SIZE,
  READER_SEARCH_SCAN_ROW_BUDGET,
  READER_SEARCH_SCAN_TEXT_BUDGET,
  assertReaderSearchQuery,
  decodeReaderSearchCursor,
  encodeReaderSearchCursor,
  normalizedReaderSearchText,
  readerAbortError,
  readerSearchHardLimit,
  readerSearchPageSize,
  readerSearchTargetId,
  throwIfReaderSearchAborted,
  type ReaderSearchCursorSource,
  type ReaderSearchCursorState,
  type ReaderSearchPage,
  type ReaderSearchPageRequest,
} from '../repositories/reader-query-contract';
import {
  activeRevisionIdForChapter,
  getLegacyChapters,
  getLogicalRevisionChapters,
  readableLegacyChapter,
} from './content-revision-read-handle';
import type {
  ParagraphSearchRow,
  RevisionParagraphPageRow,
  RevisionParagraphSearchRow,
} from './content-revision-store';
import { getItem } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';

interface ScanPosition {
  readonly paragraphIndex: number;
  readonly pageIndex?: number;
}

interface ScanSlice {
  readonly paragraphs: Paragraph[];
  readonly position?: ScanPosition;
  readonly exhausted: boolean;
  readonly scannedRows: number;
  readonly scannedTextCharacters: number;
}

interface ChapterScanInput {
  readonly db: IDBDatabase;
  readonly chapterId: string;
  readonly chapterIndex: number;
  readonly normalizedQuery: string;
  readonly source?: ReaderSearchCursorSource;
  readonly position?: ScanPosition;
  readonly matchLimit: number;
  readonly rowBudget: number;
  readonly textBudget: number;
  readonly signal: AbortSignal;
}

interface ChapterScanPage extends ScanSlice {
  readonly source: Exclude<ReaderSearchCursorSource, 'remote'>;
}

interface CursorScanOptions<Row> {
  readonly db: IDBDatabase;
  readonly storeName: string;
  readonly indexName: string;
  readonly range: IDBKeyRange;
  readonly signal: AbortSignal;
  readonly matchLimit: number;
  readonly rowBudget: number;
  readonly textBudget: number;
  readonly rowValue: (row: Row) => { paragraph: Paragraph; textLower: string; position: ScanPosition };
}

const idleSignal = new AbortController().signal;

type SearchCollectRequest =
  | {
      readonly scope: 'chapter';
      readonly chapterId: string;
      readonly query: string;
      readonly signal: AbortSignal;
    }
  | {
      readonly scope: 'book';
      readonly novelId: string;
      readonly query: string;
      readonly signal: AbortSignal;
    };

interface SearchRowCursorOptions<Row> extends Omit<CursorScanOptions<Row>, 'rowValue'> {
  readonly normalizedQuery: string;
  readonly rowValue: CursorScanOptions<Row>['rowValue'];
}

function scanSearchRows<Row>(options: SearchRowCursorOptions<Row>): Promise<ScanSlice> {
  throwIfReaderSearchAborted(options.signal);
  const tx = options.db.transaction(options.storeName, 'readonly');
  const request = tx.objectStore(options.storeName).index(options.indexName).openCursor(options.range);

  return new Promise((resolve, reject) => {
    const paragraphs: Paragraph[] = [];
    let position: ScanPosition | undefined;
    let exhausted = false;
    let scannedRows = 0;
    let scannedTextCharacters = 0;
    let settled = false;

    const cleanup = () => options.signal.removeEventListener('abort', abort);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => {
      try {
        tx.abort();
      } catch {
        fail(readerAbortError(options.signal));
      }
    };

    options.signal.addEventListener('abort', abort, { once: true });
    request.onerror = () => fail(request.error ?? new Error('IndexedDB search cursor failed.'));
    tx.onerror = () => fail(tx.error ?? new Error('IndexedDB search transaction failed.'));
    tx.onabort = () => fail(options.signal.aborted ? readerAbortError(options.signal) : tx.error);
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ paragraphs, position, exhausted, scannedRows, scannedTextCharacters });
    };
    request.onsuccess = () => {
      if (options.signal.aborted) {
        abort();
        return;
      }
      const cursor = request.result;
      if (!cursor) {
        exhausted = true;
        return;
      }
      const value = options.rowValue(cursor.value as Row);
      position = value.position;
      scannedRows += 1;
      scannedTextCharacters += value.textLower.length;
      if (value.textLower.includes(options.normalizedQuery)) paragraphs.push(value.paragraph);
      const shouldStop =
        scannedRows >= options.rowBudget ||
        scannedTextCharacters >= options.textBudget ||
        paragraphs.length >= options.matchLimit;
      if (shouldStop) return;
      cursor.continue();
    };
  });
}

function searchRowRange(prefix: IDBValidKey[], paragraphIndex: number | undefined): IDBKeyRange {
  const lower = [...prefix, paragraphIndex ?? 0];
  const upper = [...prefix, Number.MAX_SAFE_INTEGER];
  return IDBKeyRange.bound(lower, upper, paragraphIndex !== undefined, false);
}

function scanRevisionRows(
  input: ChapterScanInput,
  contentRevisionId: string,
  position: ScanPosition | undefined,
): Promise<ScanSlice> {
  return scanSearchRows<RevisionParagraphSearchRow>({
    db: input.db,
    storeName: 'book_content_paragraph_search',
    indexName: 'contentRevisionId_chapterId_paragraphIndex',
    range: searchRowRange([contentRevisionId, input.chapterId], position?.paragraphIndex),
    signal: input.signal,
    normalizedQuery: input.normalizedQuery,
    matchLimit: input.matchLimit,
    rowBudget: Math.min(READER_SEARCH_CURSOR_SLICE_ROWS, input.rowBudget),
    textBudget: input.textBudget,
    rowValue: (row) => ({
      paragraph: row.paragraph,
      textLower: row.textLower ?? row.paragraph.text.toLocaleLowerCase(),
      position: { paragraphIndex: row.paragraphIndex, pageIndex: row.pageIndex },
    }),
  });
}

function revisionPageRange(contentRevisionId: string, chapterId: string, pageIndex: number | undefined): IDBKeyRange {
  return IDBKeyRange.bound(
    [contentRevisionId, chapterId, pageIndex ?? 0],
    [contentRevisionId, chapterId, Number.MAX_SAFE_INTEGER],
    false,
    false,
  );
}

function scanIndexedRows(input: ChapterScanInput, position: ScanPosition | undefined): Promise<ScanSlice> {
  return scanSearchRows<ParagraphSearchRow>({
    db: input.db,
    storeName: 'paragraph_search',
    indexName: 'chapterId_paragraphIndex',
    range: searchRowRange([input.chapterId], position?.paragraphIndex),
    signal: input.signal,
    normalizedQuery: input.normalizedQuery,
    matchLimit: input.matchLimit,
    rowBudget: Math.min(READER_SEARCH_CURSOR_SLICE_ROWS, input.rowBudget),
    textBudget: input.textBudget,
    rowValue: (row) => ({
      paragraph: row.paragraph,
      textLower: row.textLower ?? row.paragraph.text.toLocaleLowerCase(),
      position: { paragraphIndex: row.paragraphIndex, pageIndex: row.pageIndex },
    }),
  });
}

function scanLegacyRows(input: ChapterScanInput, position: ScanPosition | undefined): Promise<ScanSlice> {
  return scanSearchRows<Paragraph>({
    db: input.db,
    storeName: 'paragraphs',
    indexName: 'chapterId_index',
    range: searchRowRange([input.chapterId], position?.paragraphIndex),
    signal: input.signal,
    normalizedQuery: input.normalizedQuery,
    matchLimit: input.matchLimit,
    rowBudget: Math.min(READER_SEARCH_CURSOR_SLICE_ROWS, input.rowBudget),
    textBudget: input.textBudget,
    rowValue: (paragraph) => ({
      paragraph,
      textLower: paragraph.text.toLocaleLowerCase(),
      position: { paragraphIndex: paragraph.index },
    }),
  });
}

function pageRange(chapterId: string, pageIndex: number | undefined): IDBKeyRange {
  return IDBKeyRange.bound([chapterId, pageIndex ?? 0], [chapterId, Number.MAX_SAFE_INTEGER], false, false);
}

function scanPageRows(input: ChapterScanInput, position: ScanPosition | undefined): Promise<ScanSlice> {
  throwIfReaderSearchAborted(input.signal);
  const tx = input.db.transaction('paragraph_pages', 'readonly');
  const request = tx
    .objectStore('paragraph_pages')
    .index('chapterId_pageIndex')
    .openCursor(pageRange(input.chapterId, position?.pageIndex));

  return new Promise((resolve, reject) => {
    const paragraphs: Paragraph[] = [];
    let nextPosition = position;
    let exhausted = false;
    let scannedRows = 0;
    let scannedTextCharacters = 0;
    let settled = false;

    const cleanup = () => input.signal.removeEventListener('abort', abort);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => {
      try {
        tx.abort();
      } catch {
        fail(readerAbortError(input.signal));
      }
    };

    input.signal.addEventListener('abort', abort, { once: true });
    request.onerror = () => fail(request.error ?? new Error('IndexedDB page search cursor failed.'));
    tx.onerror = () => fail(tx.error ?? new Error('IndexedDB page search transaction failed.'));
    tx.onabort = () => fail(input.signal.aborted ? readerAbortError(input.signal) : tx.error);
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ paragraphs, position: nextPosition, exhausted, scannedRows, scannedTextCharacters });
    };
    request.onsuccess = () => {
      if (input.signal.aborted) {
        abort();
        return;
      }
      const cursor = request.result;
      if (!cursor) {
        exhausted = true;
        return;
      }
      const page = cursor.value as ParagraphPage;
      const afterParagraph = page.pageIndex === position?.pageIndex ? position.paragraphIndex : -1;
      for (const paragraph of page.paragraphs) {
        if (paragraph.index <= afterParagraph) continue;
        const textLower = paragraph.text.toLocaleLowerCase();
        nextPosition = { pageIndex: page.pageIndex, paragraphIndex: paragraph.index };
        scannedRows += 1;
        scannedTextCharacters += textLower.length;
        if (textLower.includes(input.normalizedQuery)) paragraphs.push(paragraph);
        if (
          scannedRows >= Math.min(READER_SEARCH_CURSOR_SLICE_ROWS, input.rowBudget) ||
          scannedTextCharacters >= input.textBudget ||
          paragraphs.length >= input.matchLimit
        ) {
          return;
        }
      }
      cursor.continue();
    };
  });
}

function scanRevisionPageRows(
  input: ChapterScanInput,
  contentRevisionId: string,
  position: ScanPosition | undefined,
): Promise<ScanSlice> {
  throwIfReaderSearchAborted(input.signal);
  const tx = input.db.transaction('book_content_paragraph_pages', 'readonly');
  const request = tx
    .objectStore('book_content_paragraph_pages')
    .index('contentRevisionId_chapterId_pageIndex')
    .openCursor(revisionPageRange(contentRevisionId, input.chapterId, position?.pageIndex));

  return new Promise((resolve, reject) => {
    const paragraphs: Paragraph[] = [];
    let nextPosition = position;
    let exhausted = false;
    let scannedRows = 0;
    let scannedTextCharacters = 0;
    let settled = false;

    const cleanup = () => input.signal.removeEventListener('abort', abort);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => {
      try {
        tx.abort();
      } catch {
        fail(readerAbortError(input.signal));
      }
    };

    input.signal.addEventListener('abort', abort, { once: true });
    request.onerror = () => fail(request.error ?? new Error('IndexedDB revision page search cursor failed.'));
    tx.onerror = () => fail(tx.error ?? new Error('IndexedDB revision page search transaction failed.'));
    tx.onabort = () => fail(input.signal.aborted ? readerAbortError(input.signal) : tx.error);
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ paragraphs, position: nextPosition, exhausted, scannedRows, scannedTextCharacters });
    };
    request.onsuccess = () => {
      if (input.signal.aborted) {
        abort();
        return;
      }
      const cursor = request.result;
      if (!cursor) {
        exhausted = true;
        return;
      }
      const page = cursor.value as RevisionParagraphPageRow;
      const afterParagraph = page.pageIndex === position?.pageIndex ? position.paragraphIndex : -1;
      for (const paragraph of page.paragraphs) {
        if (paragraph.index <= afterParagraph) continue;
        const textLower = paragraph.text.toLocaleLowerCase();
        nextPosition = { pageIndex: page.pageIndex, paragraphIndex: paragraph.index };
        scannedRows += 1;
        scannedTextCharacters += textLower.length;
        if (textLower.includes(input.normalizedQuery)) paragraphs.push(paragraph);
        if (
          scannedRows >= Math.min(READER_SEARCH_CURSOR_SLICE_ROWS, input.rowBudget) ||
          scannedTextCharacters >= input.textBudget ||
          paragraphs.length >= input.matchLimit
        ) {
          return;
        }
      }
      cursor.continue();
    };
  });
}

async function yieldSearchTurn(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  throwIfReaderSearchAborted(signal);
}

async function resolveChapterSource(
  input: ChapterScanInput,
): Promise<{ source: Exclude<ReaderSearchCursorSource, 'remote'>; contentRevisionId?: string }> {
  const contentRevisionId = await activeRevisionIdForChapter(input.db, input.chapterId);
  if (input.source === 'remote') throw new Error('Remote search cursor cannot be used with IndexedDB.');
  if (contentRevisionId) {
    if (input.source && input.source !== 'revision') throw new Error('Search cursor source no longer matches content.');
    return { source: 'revision', contentRevisionId };
  }
  if (!(await readableLegacyChapter(input.db, input.chapterId))) return { source: input.source ?? 'indexed' };
  return { source: input.source ?? 'indexed' };
}

async function scanChapterPage(input: ChapterScanInput): Promise<ChapterScanPage> {
  const resolved = await resolveChapterSource(input);
  let source = resolved.source;
  let position = input.position;
  const paragraphs: Paragraph[] = [];
  let scannedRows = 0;
  let scannedTextCharacters = 0;
  let exhausted = false;
  let sourceStartedWithNoCursor = position === undefined;

  while (
    paragraphs.length < input.matchLimit &&
    scannedRows < input.rowBudget &&
    scannedTextCharacters < input.textBudget
  ) {
    throwIfReaderSearchAborted(input.signal);
    const sliceInput = {
      ...input,
      matchLimit: input.matchLimit - paragraphs.length,
      rowBudget: input.rowBudget - scannedRows,
      textBudget: input.textBudget - scannedTextCharacters,
    };
    let slice =
      source === 'revision' && resolved.contentRevisionId
        ? await scanRevisionRows(sliceInput, resolved.contentRevisionId, position)
        : source === 'indexed'
          ? await scanIndexedRows(sliceInput, position)
          : source === 'pages'
            ? await scanPageRows(sliceInput, position)
            : await scanLegacyRows(sliceInput, position);
    if (source === 'revision' && resolved.contentRevisionId && slice.exhausted && slice.scannedRows === 0) {
      slice = await scanRevisionPageRows(sliceInput, resolved.contentRevisionId, position);
    }
    paragraphs.push(...slice.paragraphs);
    scannedRows += slice.scannedRows;
    scannedTextCharacters += slice.scannedTextCharacters;
    position = slice.position ?? position;
    exhausted = slice.exhausted;

    if (slice.exhausted && slice.scannedRows === 0 && sourceStartedWithNoCursor && source === 'indexed') {
      source = 'pages';
      position = undefined;
      sourceStartedWithNoCursor = true;
      exhausted = false;
      continue;
    }
    if (slice.exhausted && slice.scannedRows === 0 && sourceStartedWithNoCursor && source === 'pages') {
      source = 'legacy';
      position = undefined;
      sourceStartedWithNoCursor = true;
      exhausted = false;
      continue;
    }
    sourceStartedWithNoCursor = false;
    if (slice.exhausted || paragraphs.length >= input.matchLimit) break;
    if (scannedRows >= input.rowBudget || scannedTextCharacters >= input.textBudget) break;
    await yieldSearchTurn(input.signal);
  }

  return { paragraphs, position, exhausted, scannedRows, scannedTextCharacters, source };
}

function cursorPosition(cursor: ReaderSearchCursorState | undefined): ScanPosition | undefined {
  return cursor ? { paragraphIndex: cursor.paragraphIndex, pageIndex: cursor.pageIndex } : undefined;
}

function emptyPage(capped = false): ReaderSearchPage {
  return { paragraphs: [], capped, scannedRows: 0, scannedTextCharacters: 0 };
}

async function searchChapter(request: ReaderSearchPageRequest & { scope: 'chapter' }): Promise<ReaderSearchPage> {
  const targetId = request.chapterId;
  const normalizedQuery = normalizedReaderSearchText(request.query);
  const cursor = decodeReaderSearchCursor(request.cursor, { scope: request.scope, targetId, query: normalizedQuery });
  if (cursor?.source === 'remote') throw new Error('Remote search cursor cannot be used with IndexedDB.');
  const hardLimit = readerSearchHardLimit(request.scope);
  const matchedCount = cursor?.matchedCount ?? 0;
  if (matchedCount >= hardLimit) return emptyPage(true);
  const matchLimit = readerSearchPageSize(request.pageSize, hardLimit - matchedCount);
  const db = await openReaderDb();
  throwIfReaderSearchAborted(request.signal);
  const page = await scanChapterPage({
    db,
    chapterId: request.chapterId,
    chapterIndex: 0,
    normalizedQuery,
    source: cursor?.source,
    position: cursorPosition(cursor),
    matchLimit,
    rowBudget: READER_SEARCH_SCAN_ROW_BUDGET,
    textBudget: READER_SEARCH_SCAN_TEXT_BUDGET,
    signal: request.signal,
  });
  const nextMatchedCount = matchedCount + page.paragraphs.length;
  const capped = nextMatchedCount >= hardLimit;
  const nextCursor =
    !capped && !page.exhausted && page.position
      ? encodeReaderSearchCursor({
          version: 1,
          scope: request.scope,
          targetId,
          query: normalizedQuery,
          source: page.source,
          chapterIndex: 0,
          paragraphIndex: page.position.paragraphIndex,
          pageIndex: page.position.pageIndex,
          matchedCount: nextMatchedCount,
        })
      : undefined;
  return {
    paragraphs: page.paragraphs,
    nextCursor,
    capped,
    scannedRows: page.scannedRows,
    scannedTextCharacters: page.scannedTextCharacters,
  };
}

function sortedChapters(chapters: Chapter[]): Chapter[] {
  return chapters.sort((left, right) => left.index - right.index || left.id.localeCompare(right.id));
}

async function chaptersForBook(novelId: string): Promise<Chapter[]> {
  const novel = await getItem<Novel>('novels', novelId);
  const db = await openReaderDb();
  const chapters = novel?.activeContentRevisionId
    ? await getLogicalRevisionChapters(db, novel.activeContentRevisionId)
    : await getLegacyChapters(db, novelId);
  return sortedChapters(chapters);
}

async function searchBook(request: ReaderSearchPageRequest & { scope: 'book' }): Promise<ReaderSearchPage> {
  const targetId = request.novelId;
  const normalizedQuery = normalizedReaderSearchText(request.query);
  const cursor = decodeReaderSearchCursor(request.cursor, { scope: request.scope, targetId, query: normalizedQuery });
  if (cursor?.source === 'remote') throw new Error('Remote search cursor cannot be used with IndexedDB.');
  const hardLimit = readerSearchHardLimit(request.scope);
  const matchedCount = cursor?.matchedCount ?? 0;
  if (matchedCount >= hardLimit) return emptyPage(true);
  const matchLimit = readerSearchPageSize(request.pageSize, hardLimit - matchedCount);
  const chapters = await chaptersForBook(request.novelId);
  const db = await openReaderDb();
  throwIfReaderSearchAborted(request.signal);
  let chapterOffset = cursor ? chapters.findIndex((chapter) => chapter.index === cursor.chapterIndex) : 0;
  if (cursor && chapterOffset < 0) throw new Error('Search cursor chapter no longer exists.');
  const paragraphs: Paragraph[] = [];
  let scannedRows = 0;
  let scannedTextCharacters = 0;
  let nextCursor: string | undefined;

  for (; chapterOffset < chapters.length; chapterOffset += 1) {
    const chapter = chapters[chapterOffset];
    const isCursorChapter = cursor?.chapterIndex === chapter.index;
    const page = await scanChapterPage({
      db,
      chapterId: chapter.id,
      chapterIndex: chapter.index,
      normalizedQuery,
      source: isCursorChapter ? cursor?.source : undefined,
      position: isCursorChapter ? cursorPosition(cursor) : undefined,
      matchLimit: matchLimit - paragraphs.length,
      rowBudget: READER_SEARCH_SCAN_ROW_BUDGET - scannedRows,
      textBudget: READER_SEARCH_SCAN_TEXT_BUDGET - scannedTextCharacters,
      signal: request.signal,
    });
    paragraphs.push(...page.paragraphs);
    scannedRows += page.scannedRows;
    scannedTextCharacters += page.scannedTextCharacters;
    const nextMatchedCount = matchedCount + paragraphs.length;
    const capped = nextMatchedCount >= hardLimit;
    if (!page.exhausted && page.position && !capped) {
      nextCursor = encodeReaderSearchCursor({
        version: 1,
        scope: request.scope,
        targetId,
        query: normalizedQuery,
        source: page.source,
        chapterIndex: chapter.index,
        paragraphIndex: page.position.paragraphIndex,
        pageIndex: page.position.pageIndex,
        matchedCount: nextMatchedCount,
      });
      break;
    }
    if (capped || paragraphs.length >= matchLimit) {
      if (!capped && page.position) {
        nextCursor = encodeReaderSearchCursor({
          version: 1,
          scope: request.scope,
          targetId,
          query: normalizedQuery,
          source: page.source,
          chapterIndex: chapter.index,
          paragraphIndex: page.position.paragraphIndex,
          pageIndex: page.position.pageIndex,
          matchedCount: nextMatchedCount,
        });
      }
      break;
    }
    if (scannedRows >= READER_SEARCH_SCAN_ROW_BUDGET || scannedTextCharacters >= READER_SEARCH_SCAN_TEXT_BUDGET) {
      if (page.position) {
        nextCursor = encodeReaderSearchCursor({
          version: 1,
          scope: request.scope,
          targetId,
          query: normalizedQuery,
          source: page.source,
          chapterIndex: chapter.index,
          paragraphIndex: page.position.paragraphIndex,
          pageIndex: page.position.pageIndex,
          matchedCount: nextMatchedCount,
        });
      }
      break;
    }
  }

  const nextMatchedCount = matchedCount + paragraphs.length;
  return {
    paragraphs,
    nextCursor,
    capped: nextMatchedCount >= hardLimit,
    scannedRows,
    scannedTextCharacters,
  };
}

export async function searchParagraphPage(request: ReaderSearchPageRequest): Promise<ReaderSearchPage> {
  throwIfReaderSearchAborted(request.signal);
  const normalizedQuery = normalizedReaderSearchText(request.query);
  assertReaderSearchQuery(normalizedQuery);
  if (!normalizedQuery) return emptyPage();
  readerSearchTargetId(request);
  return request.scope === 'chapter' ? searchChapter(request) : searchBook(request);
}

async function collectSearch(request: SearchCollectRequest, requestedLimit: number): Promise<Paragraph[]> {
  const hardLimit = readerSearchHardLimit(request.scope);
  const limit = Math.min(hardLimit, Math.max(0, Math.trunc(requestedLimit)));
  if (limit === 0) return [];
  const paragraphs: Paragraph[] = [];
  let cursor: string | undefined;
  do {
    const pageSize = Math.min(limit - paragraphs.length, READER_SEARCH_MAX_PAGE_SIZE);
    const page = await searchParagraphPage(
      request.scope === 'chapter'
        ? {
            scope: 'chapter',
            chapterId: request.chapterId,
            query: request.query,
            signal: request.signal,
            cursor,
            pageSize,
          }
        : {
            scope: 'book',
            novelId: request.novelId,
            query: request.query,
            signal: request.signal,
            cursor,
            pageSize,
          },
    );
    paragraphs.push(...page.paragraphs);
    cursor = page.nextCursor;
  } while (cursor && paragraphs.length < limit);
  return paragraphs.slice(0, limit);
}

export function searchParagraphs(
  chapterId: string,
  query: string,
  limit = readerSearchHardLimit('chapter'),
  signal: AbortSignal = idleSignal,
): Promise<Paragraph[]> {
  return collectSearch({ scope: 'chapter', chapterId, query, signal }, limit);
}

export function searchBookParagraphs(
  novelId: string,
  query: string,
  limit = readerSearchHardLimit('book'),
  signal: AbortSignal = idleSignal,
): Promise<Paragraph[]> {
  return collectSearch({ scope: 'book', novelId, query, signal }, limit);
}
