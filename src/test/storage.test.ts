import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Bookmark,
  Character,
  LabeledSegment,
  ParsedNovel,
  ParsedNovelImport,
  ReaderHighlight,
  ReaderNote,
  UserCorrection,
} from '../domain/types';
import type { CharacterRelation } from '../providers/ai';
import { integrityHash } from '../domain/id-hash-contract';
import { aggregateSyncEntityId } from '../domain/identity/sync-identities';
import { parseNovelFileForImport } from '../domain/parser';
import {
  defaultSettings,
  deleteBookmark,
  deleteCorrection,
  deleteHighlight,
  deleteNovel,
  deleteNote,
  clearReadingPosition,
  addNovelReadingTime,
  getBookmarks,
  getChapters,
  getCharacters,
  getCharacterRelations,
  getCorrections,
  getHighlights,
  getActiveContentRevisionDiagnostics,
  getNovel,
  getNovels,
  getParagraph,
  getParagraphPage,
  getParagraphPages,
  getParagraphs,
  getSegments,
  getReadingPosition,
  getSyncState,
  listSyncOutbox,
  openReaderDb,
  PARAGRAPHS_PER_PAGE,
  resetReaderDbForTests,
  saveBookmark,
  saveCharacterGraph,
  saveCharacters,
  saveCorrection,
  saveHighlight,
  saveImportedNovel,
  saveNote,
  saveParsedNovelImport,
  saveSegments,
  saveSettings,
  searchBookParagraphs,
  searchParagraphs,
  saveReadingPosition,
  applyRemoteSyncEvents,
} from '../storage/db';
import { getTrashedNovels, purgeNovel, restoreNovelFromTrash } from '../storage/library-catalog-store';
import type { BookContentRevisionRecord } from '../storage/content-revisions';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getParagraphSearchRows(novelId: string) {
  return (await getActiveContentRevisionDiagnostics(novelId)).paragraphSearchRows;
}

async function getContentRevisions(novelId: string): Promise<BookContentRevisionRecord[]> {
  const db = await openReaderDb();
  const tx = db.transaction('book_content_revisions', 'readonly');
  return requestToPromise<BookContentRevisionRecord[]>(
    tx.objectStore('book_content_revisions').index('novelId').getAll(novelId),
  );
}

function parsedNovel(id: string, title: string): ParsedNovel {
  const now = '2026-07-04T00:00:00.000Z';
  return {
    novel: {
      id,
      title,
      sourceFileName: `${title}.txt`,
      sourceEncoding: 'utf-8',
      rawText: `${title} raw`,
      normalizedText: `${title} normalized`,
      rawTextHash: `${id}:raw`,
      normalizedTextHash: `${id}:normalized`,
      createdAt: now,
      updatedAt: now,
      totalChapters: 1,
      totalCharacters: 20,
      totalParagraphs: 2,
      coverSeed: 1,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    },
    chapters: [
      {
        id: `${id}:chapter:1`,
        novelId: id,
        index: 1,
        title: '1화',
        normalizedText: '첫 문단\n\n둘째 문단',
        textHash: `${id}:chapter-hash`,
        rawStartOffset: 0,
        rawEndOffset: 12,
        characterCount: 12,
        paragraphCount: 2,
        createdAt: now,
        updatedAt: now,
      },
    ],
    paragraphs: [
      {
        id: `${id}:paragraph:2`,
        novelId: id,
        chapterId: `${id}:chapter:1`,
        index: 2,
        text: '둘째 문단',
        startOffsetInChapter: 6,
        endOffsetInChapter: 11,
        textHash: `${id}:paragraph-2`,
      },
      {
        id: `${id}:paragraph:1`,
        novelId: id,
        chapterId: `${id}:chapter:1`,
        index: 1,
        text: '첫 문단',
        startOffsetInChapter: 0,
        endOffsetInChapter: 4,
        textHash: `${id}:paragraph-1`,
      },
    ],
  };
}

function parsedNovelWithParagraphCount(id: string, count: number): ParsedNovel {
  const novel = parsedNovel(id, '긴 책');
  const paragraphs = Array.from({ length: count }, (_, index) => {
    const paragraphIndex = index + 1;
    const text = `문단 ${paragraphIndex}`;
    return {
      id: `${id}:paragraph:${paragraphIndex}`,
      novelId: id,
      chapterId: `${id}:chapter:1`,
      index: paragraphIndex,
      text,
      startOffsetInChapter: index * 10,
      endOffsetInChapter: index * 10 + text.length,
      textHash: `${id}:paragraph-${paragraphIndex}`,
    };
  });
  return {
    ...novel,
    novel: {
      ...novel.novel,
      totalCharacters: paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0),
      totalParagraphs: paragraphs.length,
    },
    chapters: [
      {
        ...novel.chapters[0],
        paragraphCount: paragraphs.length,
        characterCount: paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0),
        normalizedText: paragraphs.map((paragraph) => paragraph.text).join('\n\n'),
      },
    ],
    paragraphs,
  };
}

function parsedImportFromParsedNovel(parsed: ParsedNovel): ParsedNovelImport {
  return {
    novel: parsed.novel,
    chapters: parsed.chapters,
    consumeChapterParagraphs() {
      return parsed.chapters.map((chapter) => ({
        chapter,
        paragraphs: parsed.paragraphs.filter((paragraph) => paragraph.chapterId === chapter.id),
      }));
    },
  };
}

function textBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function importTextWithParagraphCount(count: number): ArrayBuffer {
  const paragraphs = Array.from({ length: count }, (_, index) => `문단 ${index + 1}`);
  return textBuffer(`제 1화 시작\n\n${paragraphs.join('\n\n')}`);
}

async function createLegacyV4Database(novel: ParsedNovel['novel']): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('noveldesk-reader', 4);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.createObjectStore('novels', { keyPath: 'id' });
      store.createIndex('updatedAt', 'updatedAt');
      store.createIndex('title', 'title');
      store.put(novel);
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

async function createLegacyV7PageBackedDatabase(novel: ParsedNovel): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('noveldesk-reader', 7);
    request.onupgradeneeded = () => {
      const db = request.result;
      const novelStore = db.createObjectStore('novels', { keyPath: 'id' });
      novelStore.createIndex('updatedAt', 'updatedAt');
      novelStore.createIndex('title', 'title');
      novelStore.put(novel.novel);

      const chapterStore = db.createObjectStore('chapters', { keyPath: 'id' });
      chapterStore.createIndex('novelId', 'novelId');
      novel.chapters.forEach((chapter) => chapterStore.put(chapter));

      const paragraphStore = db.createObjectStore('paragraphs', { keyPath: 'id' });
      paragraphStore.createIndex('novelId', 'novelId');
      paragraphStore.createIndex('chapterId', 'chapterId');
      paragraphStore.createIndex('chapterId_index', ['chapterId', 'index'], { unique: true });
      novel.paragraphs.forEach((paragraph) => paragraphStore.put(paragraph));

      const pageStore = db.createObjectStore('paragraph_pages', { keyPath: 'id' });
      pageStore.createIndex('novelId', 'novelId');
      pageStore.createIndex('chapterId', 'chapterId');
      pageStore.createIndex('chapterId_pageIndex', ['chapterId', 'pageIndex'], { unique: true });
      pageStore.put({
        id: `${novel.novel.id}:page:0`,
        novelId: novel.novel.id,
        chapterId: novel.chapters[0].id,
        pageIndex: 0,
        startParagraphIndex: 1,
        endParagraphIndex: 2,
        paragraphs: novel.paragraphs,
        textHash: `${novel.novel.id}:page-hash`,
      });
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

describe('IndexedDB reader storage', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('reads chapter-scoped data through indexes without full store getAll scans', async () => {
    await saveImportedNovel(parsedNovel('novel-a', '첫 책'));
    await saveImportedNovel(parsedNovel('novel-b', '둘째 책'));
    const bookmark: Bookmark = {
      id: 'bookmark-a',
      novelId: 'novel-a',
      chapterId: 'novel-a:chapter:1',
      paragraphId: 'novel-a:paragraph:1',
      label: '1화 · 10%',
      progress: 0.1,
      scrollTop: 12,
      createdAt: '2026-07-04T00:01:00.000Z',
    };
    await saveBookmark(bookmark);
    const highlight: ReaderHighlight = {
      id: 'highlight-a',
      novelId: 'novel-a',
      chapterId: 'novel-a:chapter:1',
      paragraphId: 'novel-a:paragraph:1',
      quote: '첫 문단',
      color: 'yellow',
      progress: 0.1,
      createdAt: '2026-07-04T00:01:30.000Z',
      updatedAt: '2026-07-04T00:01:30.000Z',
    };
    await saveHighlight(highlight);

    const storeGetAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const chapters = await getChapters('novel-a');
    const storedNovel = await getNovel('novel-a');
    const pages = await getParagraphPages('novel-a:chapter:1');
    const page = await getParagraphPage('novel-a:chapter:1', 0);
    const paragraph = await getParagraph('novel-a:paragraph:1');
    const paragraphs = await getParagraphs('novel-a:chapter:1');
    const rawParagraphRef = (await getActiveContentRevisionDiagnostics('novel-a')).paragraphRefs.find(
      (item) => item.id === 'novel-a:paragraph:1',
    );
    const searchRows = await getParagraphSearchRows('novel-a');
    const bookmarks = await getBookmarks('novel-a');
    const highlights = await getHighlights('novel-a');
    const paragraphMatches = await searchParagraphs('novel-a:chapter:1', pages[0].paragraphs[0].text.slice(0, 2));

    expect(chapters.map((chapter) => chapter.id)).toEqual(['novel-a:chapter:1']);
    expect(storedNovel).toMatchObject({ rawText: '', normalizedText: '' });
    expect(chapters[0].normalizedText).toBe('');
    expect(pages).toHaveLength(1);
    expect(page?.paragraphs.map((item) => item.index)).toEqual([1, 2]);
    expect(paragraph).toMatchObject({ id: 'novel-a:paragraph:1', text: '첫 문단' });
    expect(rawParagraphRef).toMatchObject({
      id: 'novel-a:paragraph:1',
      text: '',
      pageIndex: 0,
      textStorageMode: 'page',
    });
    expect(searchRows).toHaveLength(2);
    expect(searchRows[0]).toMatchObject({ paragraphId: 'novel-a:paragraph:1', pageIndex: 0, paragraphIndex: 1 });
    expect(pages[0].paragraphs.map((paragraph) => paragraph.index)).toEqual([1, 2]);
    expect(paragraphs.map((paragraph) => paragraph.index)).toEqual([1, 2]);
    expect(bookmarks.map((item) => item.id)).toEqual(['bookmark-a']);
    expect(highlights.map((item) => item.id)).toEqual(['highlight-a']);
    expect(paragraphMatches.length).toBeGreaterThan(0);
    expect(storeGetAll).not.toHaveBeenCalled();
    storeGetAll.mockRestore();
  });

  it('searches across all chapters with the page-backed data source', async () => {
    const novel = parsedNovel('novel-search', '검색 책');
    novel.novel.totalChapters = 2;
    novel.novel.totalParagraphs = 4;
    novel.chapters.push({
      ...novel.chapters[0],
      id: 'novel-search:chapter:2',
      index: 2,
      title: '2화',
      normalizedText: '셋째 문단\n\n다시 찾는 단서',
      paragraphCount: 2,
    });
    novel.paragraphs.push(
      {
        id: 'novel-search:paragraph:3',
        novelId: 'novel-search',
        chapterId: 'novel-search:chapter:2',
        index: 1,
        text: '셋째 문단',
        startOffsetInChapter: 0,
        endOffsetInChapter: 4,
        textHash: 'novel-search:paragraph-3',
      },
      {
        id: 'novel-search:paragraph:4',
        novelId: 'novel-search',
        chapterId: 'novel-search:chapter:2',
        index: 2,
        text: '다시 찾는 단서',
        startOffsetInChapter: 6,
        endOffsetInChapter: 14,
        textHash: 'novel-search:paragraph-4',
      },
    );
    await saveImportedNovel(novel);
    const otherNovel = parsedNovel('novel-search-other', '다른 검색 책');
    otherNovel.paragraphs = otherNovel.paragraphs.map((paragraph) => ({
      ...paragraph,
      text: `${paragraph.text} 문단`,
    }));
    await saveImportedNovel(otherNovel);

    const matches = await searchBookParagraphs('novel-search', '문단');
    const limited = await searchBookParagraphs('novel-search', '문단', 2);

    expect(matches.map((paragraph) => paragraph.id)).toEqual([
      'novel-search:paragraph:1',
      'novel-search:paragraph:2',
      'novel-search:paragraph:3',
    ]);
    expect(limited.map((paragraph) => paragraph.id)).toEqual(['novel-search:paragraph:1', 'novel-search:paragraph:2']);
  });

  it('migrates v7 page-backed paragraph rows to lightweight refs', async () => {
    const legacy = parsedNovel('novel-v7', '이전 책');
    const firstLegacyParagraph = legacy.paragraphs.find((paragraph) => paragraph.id === 'novel-v7:paragraph:1')!;
    await createLegacyV7PageBackedDatabase(legacy);

    const paragraph = await getParagraph('novel-v7:paragraph:1');
    const rawParagraphRef = await requestToPromise<Record<string, unknown> | undefined>(
      (await openReaderDb())
        .transaction('paragraphs', 'readonly')
        .objectStore('paragraphs')
        .get('novel-v7:paragraph:1'),
    );
    const searchRows = await getParagraphSearchRows('novel-v7');
    const matches = await searchParagraphs('novel-v7:chapter:1', firstLegacyParagraph.text, 5);

    expect(paragraph).toMatchObject({ id: 'novel-v7:paragraph:1', text: '첫 문단' });
    expect(rawParagraphRef).toMatchObject({
      id: 'novel-v7:paragraph:1',
      text: '',
      pageIndex: 0,
      textStorageMode: 'page',
    });
    expect(searchRows).toHaveLength(2);
    expect(searchRows[0]).toMatchObject({ paragraphId: 'novel-v7:paragraph:1', pageIndex: 0, paragraphIndex: 1 });
    expect(matches.map((item) => item.id)).toEqual(['novel-v7:paragraph:1']);
  });

  it('writes imported paragraph pages in batches and reports persisted progress', async () => {
    const totalParagraphs = PARAGRAPHS_PER_PAGE * 2 + 5;
    const progress: Array<{ phase: string; paragraphsWritten: number }> = [];
    await saveImportedNovel(parsedNovelWithParagraphCount('novel-batch', totalParagraphs), {
      batchPageCount: 1,
      onProgress: (next) => {
        progress.push({ phase: next.phase, paragraphsWritten: next.paragraphsWritten });
      },
    });

    const pages = await getParagraphPages('novel-batch:chapter:1');
    const lastParagraph = await getParagraph(`novel-batch:paragraph:${totalParagraphs}`);
    const rawParagraphRef = (await getActiveContentRevisionDiagnostics('novel-batch')).paragraphRefs.find(
      (item) => item.id === `novel-batch:paragraph:${totalParagraphs}`,
    );

    expect(progress).toEqual([
      { phase: 'writing_pages', paragraphsWritten: PARAGRAPHS_PER_PAGE },
      { phase: 'writing_pages', paragraphsWritten: PARAGRAPHS_PER_PAGE * 2 },
      { phase: 'writing_pages', paragraphsWritten: totalParagraphs },
      { phase: 'activating_revision', paragraphsWritten: totalParagraphs },
    ]);
    expect(pages).toHaveLength(3);
    expect(lastParagraph).toMatchObject({
      id: `novel-batch:paragraph:${totalParagraphs}`,
      text: `문단 ${totalParagraphs}`,
    });
    expect(rawParagraphRef).toMatchObject({
      id: `novel-batch:paragraph:${totalParagraphs}`,
      text: '',
      pageIndex: 2,
      textStorageMode: 'page',
    });
  });

  it('saves parser import output without requiring a full ParsedNovel paragraph array', async () => {
    const totalParagraphs = PARAGRAPHS_PER_PAGE + 3;
    const parsed = await parseNovelFileForImport(
      'import-ready.txt',
      importTextWithParagraphCount(totalParagraphs),
      'utf-8',
    );
    const progress: Array<{ phase: string; paragraphsWritten: number }> = [];

    await saveParsedNovelImport(parsed, {
      batchPageCount: 1,
      onProgress: (next) => {
        progress.push({ phase: next.phase, paragraphsWritten: next.paragraphsWritten });
      },
    });

    const novel = await getNovel(parsed.novel.id);
    const chapters = await getChapters(parsed.novel.id);
    const pages = await getParagraphPages(parsed.chapters[0].id);
    const lateParagraph = await getParagraph(pages[1].paragraphs[2].id);
    const matches = await searchBookParagraphs(parsed.novel.id, `문단 ${totalParagraphs}`, 3);

    expect(novel).toMatchObject({ rawText: '', normalizedText: '', totalParagraphs });
    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toMatchObject({ normalizedText: '', paragraphCount: totalParagraphs });
    expect(pages).toHaveLength(2);
    expect(lateParagraph?.text).toBe(`문단 ${totalParagraphs}`);
    expect(matches.map((paragraph) => paragraph.text)).toEqual([`문단 ${totalParagraphs}`]);
    expect(progress).toEqual([
      { phase: 'writing_pages', paragraphsWritten: PARAGRAPHS_PER_PAGE },
      { phase: 'writing_pages', paragraphsWritten: totalParagraphs },
      { phase: 'activating_revision', paragraphsWritten: totalParagraphs },
    ]);
  });

  it('saves async parser import chapter sources in page batches', async () => {
    const totalParagraphs = PARAGRAPHS_PER_PAGE + 4;
    const parsed = await parseNovelFileForImport(
      'import-ready-async.txt',
      importTextWithParagraphCount(totalParagraphs),
      'utf-8',
    );
    const emittedChapterIds: string[] = [];
    const progress: Array<{ phase: string; paragraphsWritten: number }> = [];
    let consumed = false;
    const asyncParsed: ParsedNovelImport = {
      ...parsed,
      consumeChapterParagraphs() {
        if (consumed) return [];
        consumed = true;
        const source = parsed.consumeChapterParagraphs();
        return (async function* () {
          for await (const chapter of source) {
            emittedChapterIds.push(chapter.chapter.id);
            await Promise.resolve();
            yield chapter;
          }
        })();
      },
    };

    await saveParsedNovelImport(asyncParsed, {
      batchPageCount: 1,
      onProgress: (next) => {
        progress.push({ phase: next.phase, paragraphsWritten: next.paragraphsWritten });
      },
    });

    const pages = await getParagraphPages(parsed.chapters[0].id);
    const lateParagraph = await getParagraph(pages[1].paragraphs[3].id);

    expect(emittedChapterIds).toEqual(parsed.chapters.map((chapter) => chapter.id));
    expect(pages).toHaveLength(2);
    expect(lateParagraph?.text).toBe(`문단 ${totalParagraphs}`);
    expect(progress).toEqual([
      { phase: 'writing_pages', paragraphsWritten: PARAGRAPHS_PER_PAGE },
      { phase: 'writing_pages', paragraphsWritten: totalParagraphs },
      { phase: 'activating_revision', paragraphsWritten: totalParagraphs },
    ]);
  });

  it('cleans up partial rows when a new import is cancelled during page writes', async () => {
    const totalParagraphs = PARAGRAPHS_PER_PAGE * 2 + 5;
    const parsed = parsedNovelWithParagraphCount('novel-cancelled', totalParagraphs);
    let cancelled = false;

    await expect(
      saveImportedNovel(parsed, {
        batchPageCount: 1,
        shouldCancel: () => cancelled,
        onProgress: () => {
          cancelled = true;
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(await getNovel(parsed.novel.id)).toBeUndefined();
    expect(await getChapters(parsed.novel.id)).toEqual([]);
    expect(await getParagraphPages(parsed.chapters[0].id)).toEqual([]);
    expect(await getParagraphPage(parsed.chapters[0].id, 0)).toBeUndefined();
    expect(await getParagraph(parsed.paragraphs[0].id)).toBeUndefined();
    expect(await getParagraphSearchRows(parsed.novel.id)).toEqual([]);
    expect(await getContentRevisions(parsed.novel.id)).toEqual([]);
    expect(await listSyncOutbox()).toEqual([]);
  });

  it('cleans up parser import rows when cancellation happens during page writes', async () => {
    const parsed = await parseNovelFileForImport(
      'import-ready-cancelled.txt',
      importTextWithParagraphCount(PARAGRAPHS_PER_PAGE + 2),
      'utf-8',
    );
    let cancelled = false;

    await expect(
      saveParsedNovelImport(parsed, {
        batchPageCount: 1,
        shouldCancel: () => cancelled,
        onProgress: () => {
          cancelled = true;
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(await getNovel(parsed.novel.id)).toBeUndefined();
    expect(await getChapters(parsed.novel.id)).toEqual([]);
    expect(await getParagraphPages(parsed.chapters[0].id)).toEqual([]);
    expect(await getParagraphSearchRows(parsed.novel.id)).toEqual([]);
    expect(await listSyncOutbox()).toEqual([]);
  });

  it('restores existing imported content when a replacement import is cancelled', async () => {
    const original = parsedNovel('novel-existing', '원본');
    await saveImportedNovel(original);
    const originalOutbox = await listSyncOutbox();
    const originalRevisions = await getContentRevisions(original.novel.id);
    const replacement = parsedNovelWithParagraphCount('novel-existing', PARAGRAPHS_PER_PAGE * 2 + 5);
    let cancelled = false;

    await expect(
      saveImportedNovel(replacement, {
        batchPageCount: 1,
        shouldCancel: () => cancelled,
        onProgress: () => {
          cancelled = true;
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    const novel = await getNovel(original.novel.id);
    const chapters = await getChapters(original.novel.id);
    const pages = await getParagraphPages(original.chapters[0].id);
    const searchRows = await getParagraphSearchRows(original.novel.id);
    expect(novel?.title).toBe('원본');
    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toMatchObject({ id: original.chapters[0].id, paragraphCount: 2 });
    expect(pages).toHaveLength(1);
    expect(pages[0].paragraphs.map((paragraph) => paragraph.text)).toEqual(['첫 문단', '둘째 문단']);
    expect(searchRows).toHaveLength(2);
    expect(await getParagraph(`${original.novel.id}:paragraph:3`)).toBeUndefined();
    expect(await getContentRevisions(original.novel.id)).toEqual(originalRevisions);
    expect(await listSyncOutbox()).toEqual(originalOutbox);
  });

  it('restores existing parser-import content when a replacement import is cancelled', async () => {
    const original = parsedNovel('parser-existing', 'parser original');
    await saveParsedNovelImport(parsedImportFromParsedNovel(original));
    const originalOutbox = await listSyncOutbox();
    const replacement = parsedNovelWithParagraphCount('parser-existing', PARAGRAPHS_PER_PAGE * 2 + 5);
    let cancelled = false;

    await expect(
      saveParsedNovelImport(parsedImportFromParsedNovel(replacement), {
        batchPageCount: 1,
        shouldCancel: () => cancelled,
        onProgress: () => {
          cancelled = true;
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    const pages = await getParagraphPages(original.chapters[0].id);
    const searchRows = await getParagraphSearchRows(original.novel.id);

    expect(await getNovel(original.novel.id)).toMatchObject({ id: original.novel.id, title: 'parser original' });
    expect(await getChapters(original.novel.id)).toHaveLength(1);
    expect(pages).toHaveLength(1);
    expect(searchRows).toHaveLength(2);
    expect(await getParagraph(`${original.novel.id}:paragraph:3`)).toBeUndefined();
    expect(await searchBookParagraphs(original.novel.id, original.paragraphs[0].text, 5)).toHaveLength(1);
    expect(await listSyncOutbox()).toEqual(originalOutbox);
  });

  it('clears stale paragraph rows when a replacement import completes', async () => {
    const original = parsedNovelWithParagraphCount('novel-replace', PARAGRAPHS_PER_PAGE * 2 + 5);
    const staleText = original.paragraphs[original.paragraphs.length - 1].text;
    await saveImportedNovel(original);

    const replacement = parsedNovel('novel-replace', 'replacement');
    await saveImportedNovel(replacement);

    const pages = await getParagraphPages(replacement.chapters[0].id);
    const searchRows = await getParagraphSearchRows(replacement.novel.id);

    expect(pages).toHaveLength(1);
    expect(searchRows).toHaveLength(2);
    expect(await getParagraph(`${replacement.novel.id}:paragraph:3`)).toBeUndefined();
    expect(await searchBookParagraphs(replacement.novel.id, staleText, 5)).toEqual([]);
  });

  it('clears stale parser-import paragraph rows when a replacement import completes', async () => {
    const original = parsedNovelWithParagraphCount('parser-replace', PARAGRAPHS_PER_PAGE * 2 + 5);
    const staleText = original.paragraphs[original.paragraphs.length - 1].text;
    await saveParsedNovelImport(parsedImportFromParsedNovel(original));

    const replacement = parsedNovel('parser-replace', 'parser replacement');
    await saveParsedNovelImport(parsedImportFromParsedNovel(replacement));

    const pages = await getParagraphPages(replacement.chapters[0].id);
    const searchRows = await getParagraphSearchRows(replacement.novel.id);

    expect(pages).toHaveLength(1);
    expect(searchRows).toHaveLength(2);
    expect(await getParagraph(`${replacement.novel.id}:paragraph:3`)).toBeUndefined();
    expect(await searchBookParagraphs(replacement.novel.id, staleText, 5)).toEqual([]);
  });

  it('records reading positions and local sync outbox events', async () => {
    await saveImportedNovel(parsedNovel('novel-a', '첫 책'));
    await saveReadingPosition({
      novelId: 'novel-a',
      chapterId: 'novel-a:chapter:1',
      scrollTop: 120.3,
      chapterProgress: 0.62,
      paragraphId: 'novel-a:paragraph:2',
      paragraphIndex: 2,
      offsetInParagraph: 3,
    });

    const bookmark: Bookmark = {
      id: 'bookmark-a',
      novelId: 'novel-a',
      chapterId: 'novel-a:chapter:1',
      paragraphId: 'novel-a:paragraph:2',
      label: 'sync bookmark',
      progress: 0.62,
      scrollTop: 120,
      createdAt: '2026-07-04T00:03:00.000Z',
    };
    await saveBookmark(bookmark);
    await deleteBookmark(bookmark.id);

    const highlight: ReaderHighlight = {
      id: 'highlight-a',
      novelId: 'novel-a',
      chapterId: 'novel-a:chapter:1',
      paragraphId: 'novel-a:paragraph:2',
      quote: 'sync highlight',
      color: 'green',
      progress: 0.62,
      createdAt: '2026-07-04T00:03:30.000Z',
      updatedAt: '2026-07-04T00:03:30.000Z',
    };
    await saveHighlight(highlight);
    await deleteHighlight(highlight.id);

    const note: ReaderNote = {
      id: 'note-a',
      novelId: 'novel-a',
      chapterId: 'novel-a:chapter:1',
      paragraphId: 'novel-a:paragraph:2',
      body: 'sync note',
      progress: 0.62,
      createdAt: '2026-07-04T00:04:00.000Z',
      updatedAt: '2026-07-04T00:04:00.000Z',
    };
    await saveNote(note);
    await saveNote({ ...note, body: 'sync note updated', updatedAt: '2026-07-04T00:04:30.000Z' });
    await deleteNote(note.id);
    await saveSettings({ ...defaultSettings, fontSize: defaultSettings.fontSize + 1 });

    const position = await getReadingPosition('novel-a');
    expect(position).toMatchObject({
      novelId: 'novel-a',
      chapterId: 'novel-a:chapter:1',
      paragraphId: 'novel-a:paragraph:2',
      paragraphIndex: 2,
      offsetInParagraph: 3,
      chapterProgress: 0.62,
      scrollTop: 120,
    });

    const outbox = await listSyncOutbox('pending');
    const eventTypes = outbox.map((item) => item.event.type);
    expect(eventTypes).toEqual([
      'book_imported',
      'reading_position_updated',
      'bookmark_created',
      'bookmark_deleted',
      'highlight_created',
      'highlight_deleted',
      'note_created',
      'note_updated',
      'note_deleted',
      'settings_updated',
    ]);
    expect(outbox.map((item) => item.localSequence)).toEqual(outbox.map((_, index) => index + 1));
    expect(outbox.every((item) => item.status === 'pending')).toBe(true);
    expect(outbox.every((item) => item.event.deviceId === 'device_local')).toBe(true);
    expect(outbox.every((item) => item.event.revision?.localSequence === item.localSequence)).toBe(true);
    expect(outbox.every((item) => typeof item.event.revision?.payloadHash === 'string')).toBe(true);
    expect(outbox[0].event.revision).toMatchObject({
      entityType: 'book',
      entityId: 'novel-a',
      novelId: 'novel-a',
      localSequence: 1,
    });
    expect(outbox[1].event.revision).toMatchObject({
      entityType: 'reading_position',
      entityId: 'reading_position_novel-a',
      novelId: 'novel-a',
      localSequence: 2,
      updatedAt: position?.updatedAt,
    });
    expect(outbox[3].event.revision).toMatchObject({
      entityType: 'bookmark',
      entityId: 'bookmark-a',
      novelId: 'novel-a',
      localSequence: 4,
      deletedAt: expect.any(String),
    });
    expect(outbox[3].event.revision?.updatedAt).toBeUndefined();
    expect(outbox[8].event.revision).toMatchObject({
      entityType: 'note',
      entityId: 'note-a',
      novelId: 'novel-a',
      localSequence: 9,
      deletedAt: expect.any(String),
    });
    expect(await getSyncState()).toMatchObject({
      mode: 'local_only',
      status: 'local_only',
      pendingCount: outbox.length,
    });
  });

  it('clears reading positions and records a local sync event', async () => {
    await saveImportedNovel(parsedNovel('novel-clear-progress', '초기화 책'));
    await saveReadingPosition({
      novelId: 'novel-clear-progress',
      chapterId: 'novel-clear-progress:chapter:1',
      scrollTop: 120.3,
      chapterProgress: 0.62,
      paragraphId: 'novel-clear-progress:paragraph:2',
      paragraphIndex: 2,
      offsetInParagraph: 3,
    });
    await clearReadingPosition('novel-clear-progress');

    expect(await getReadingPosition('novel-clear-progress')).toBeUndefined();
    expect(await getNovel('novel-clear-progress')).toMatchObject({
      lastReadChapterId: undefined,
      lastReadChapterIndex: undefined,
      lastReadParagraphId: undefined,
      lastReadOffset: 0,
      lastReadProgress: 0,
    });

    const outbox = await listSyncOutbox('pending');
    expect(outbox.map((item) => item.event.type)).toEqual([
      'book_imported',
      'reading_position_updated',
      'reading_position_deleted',
    ]);
    expect(outbox.at(-1)?.event.payload).toMatchObject({
      id: 'reading_position_novel-clear-progress',
    });
  });

  it('stores local reading time without queuing sync events', async () => {
    await saveImportedNovel(parsedNovel('novel-reading-time', '통계 책'));
    await addNovelReadingTime('novel-reading-time', 35, '2026-07-05T00:10:00.000Z');
    await addNovelReadingTime('novel-reading-time', 12.8, '2026-07-05T00:11:00.000Z');
    await addNovelReadingTime('novel-reading-time', 0, '2026-07-05T00:12:00.000Z');

    expect(await getNovel('novel-reading-time')).toMatchObject({
      readingSeconds: 47,
      lastReadAt: '2026-07-05T00:11:00.000Z',
      updatedAt: '2026-07-05T00:11:00.000Z',
    });
    expect((await listSyncOutbox('pending')).map((item) => item.event.type)).toEqual(['book_imported']);
  });

  it('replaces chapter segments atomically, including empty analysis results', async () => {
    const baseSegment: LabeledSegment = {
      id: 'segment-a',
      novelId: 'novel-segments',
      chapterId: 'chapter-segments',
      paragraphId: 'paragraph-segments',
      segmentIndex: 0,
      startOffset: 0,
      endOffset: 4,
      segmentTextHash: integrityHash('segment-a'),
      type: 'quoted_dialogue',
      speakerId: 'char-a',
      candidateSpeakers: ['char-a'],
      listenerIds: [],
      emotion: 'neutral',
      confidence: 0.9,
      isUserCorrected: false,
    };

    await saveSegments('chapter-segments', [
      baseSegment,
      {
        ...baseSegment,
        id: 'segment-b',
        segmentIndex: 1,
        startOffset: 5,
        endOffset: 8,
        segmentTextHash: integrityHash('segment-b'),
      },
    ]);
    await saveSegments('chapter-segments', [
      { ...baseSegment, id: 'segment-c', segmentTextHash: integrityHash('segment-c') },
    ]);
    expect((await getSegments('chapter-segments')).map((segment) => segment.id)).toEqual(['segment-c']);

    await saveSegments('chapter-segments', []);
    expect(await getSegments('chapter-segments')).toEqual([]);
  });

  it('replaces novel characters atomically, including empty analysis results', async () => {
    const baseCharacter: Character = {
      id: 'char-a',
      novelId: 'novel-characters',
      canonicalName: '강현우',
      aliases: ['현우'],
      color: '#3b82f6',
      confidence: 0.9,
      isUserConfirmed: false,
    };

    await saveCharacters('novel-characters', [
      baseCharacter,
      { ...baseCharacter, id: 'char-b', canonicalName: '이서연', aliases: ['서연'] },
    ]);
    await saveCharacters('novel-characters', [{ ...baseCharacter, id: 'char-c', canonicalName: '박민재' }]);
    expect((await getCharacters('novel-characters')).map((character) => character.id)).toEqual(['char-c']);

    await saveCharacters('novel-characters', []);
    expect(await getCharacters('novel-characters')).toEqual([]);
  });

  it('replaces Character Graph characters and relations in one syncable write', async () => {
    const characters: Character[] = [
      {
        id: 'char-graph-a',
        novelId: 'novel-character-graph',
        canonicalName: 'Graph A',
        aliases: ['A'],
        color: '#111111',
        confidence: 0.9,
        isUserConfirmed: true,
      },
      {
        id: 'char-graph-b',
        novelId: 'novel-character-graph',
        canonicalName: 'Graph B',
        aliases: ['B'],
        color: '#222222',
        confidence: 0.8,
        isUserConfirmed: false,
      },
    ];
    const relations: CharacterRelation[] = [
      {
        id: 'rel-graph-a-b',
        novelId: 'novel-character-graph',
        sourceCharacterId: 'char-graph-a',
        targetCharacterId: 'char-graph-b',
        relationLabel: 'ally',
        termsUsedBySource: ['B'],
        termsUsedByTarget: ['A'],
        confidence: 0.7,
        evidence: ['chapter 1'],
      },
    ];

    await saveCharacterGraph('novel-character-graph', { characters, relations });

    expect((await getCharacters('novel-character-graph')).map((character) => character.id)).toEqual([
      'char-graph-a',
      'char-graph-b',
    ]);
    expect((await getCharacterRelations('novel-character-graph')).map((relation) => relation.id)).toEqual([
      'rel-graph-a-b',
    ]);
    const [outboxItem] = await listSyncOutbox();
    expect(outboxItem?.event).toMatchObject({
      type: 'character_graph_updated',
      entityId: aggregateSyncEntityId({ entityType: 'character_graph', novelId: 'novel-character-graph' }),
      payload: {
        mode: 'replace',
        characters: [expect.objectContaining({ id: 'char-graph-a' }), expect.objectContaining({ id: 'char-graph-b' })],
        relations: [expect.objectContaining({ id: 'rel-graph-a-b', relationLabel: 'ally' })],
      },
    });

    await saveCharacterGraph('novel-character-graph', { characters: [characters[0]!], relations: [] });

    expect((await getCharacters('novel-character-graph')).map((character) => character.id)).toEqual(['char-graph-a']);
    expect(await getCharacterRelations('novel-character-graph')).toEqual([]);
  });

  it('deletes user corrections with sync tombstones that block stale remote recreates', async () => {
    const correction: UserCorrection = {
      id: 'correction-delete-1',
      novelId: 'novel-correction-delete',
      chapterId: 'chapter-correction-delete',
      paragraphId: 'paragraph-correction-delete',
      segmentId: 'segment-correction-delete',
      correctionType: 'emotion',
      beforeJson: JSON.stringify({ emotion: 'neutral' }),
      afterJson: JSON.stringify({ emotion: 'tense' }),
      applyScope: 'chapter',
      createdAt: '2026-07-05T00:00:00.000Z',
    };

    await saveCorrection(correction);
    expect((await getCorrections('novel-correction-delete')).map((item) => item.id)).toEqual(['correction-delete-1']);

    await deleteCorrection('novel-correction-delete', 'correction-delete-1');

    expect(await getCorrections('novel-correction-delete')).toEqual([]);
    const outbox = await listSyncOutbox();
    expect(outbox.map((item) => item.event.type)).toEqual(['user_correction_created', 'user_correction_deleted']);
    expect(outbox[1]?.event).toMatchObject({
      novelId: 'novel-correction-delete',
      entityId: 'correction-delete-1',
      payload: expect.objectContaining({
        id: 'correction-delete-1',
        deletedAt: expect.any(String),
      }),
    });

    await applyRemoteSyncEvents([
      {
        id: 'remote-stale-correction-create',
        type: 'user_correction_created',
        deviceId: 'server',
        novelId: 'novel-correction-delete',
        entityId: 'correction-delete-1',
        payload: JSON.parse(JSON.stringify({ correction })),
        createdAt: '2026-07-05T00:00:00.000Z',
      },
    ]);

    expect(await getCorrections('novel-correction-delete')).toEqual([]);
  });

  it('stores novel progress as whole-book progress while reading position keeps chapter progress', async () => {
    const parsed = parsedNovel('novel-progress', '진행률 책');
    parsed.novel.totalChapters = 3;
    parsed.novel.totalParagraphs = 6;
    parsed.paragraphs.push(
      ...parsed.paragraphs.map((paragraph) => ({
        ...paragraph,
        id: paragraph.id.replace('paragraph:', 'chapter:2:paragraph:'),
        chapterId: 'novel-progress:chapter:2',
      })),
      ...parsed.paragraphs.map((paragraph) => ({
        ...paragraph,
        id: paragraph.id.replace('paragraph:', 'chapter:3:paragraph:'),
        chapterId: 'novel-progress:chapter:3',
      })),
    );
    parsed.chapters.push(
      {
        ...parsed.chapters[0],
        id: 'novel-progress:chapter:2',
        index: 2,
        title: '2화',
        normalizedText: '중간 화',
      },
      {
        ...parsed.chapters[0],
        id: 'novel-progress:chapter:3',
        index: 3,
        title: '3화',
        normalizedText: '마지막 화',
      },
    );
    await saveImportedNovel(parsed);

    await saveReadingPosition({
      novelId: 'novel-progress',
      chapterId: 'novel-progress:chapter:2',
      scrollTop: 200,
      chapterProgress: 0.2,
      paragraphIndex: 0,
    });

    expect(await getReadingPosition('novel-progress')).toMatchObject({
      chapterId: 'novel-progress:chapter:2',
      chapterProgress: 0.2,
    });
    const novel = await getNovel('novel-progress');
    expect(novel).toMatchObject({
      lastReadChapterId: 'novel-progress:chapter:2',
      lastReadChapterIndex: 2,
    });
    expect(novel?.lastReadProgress).toBeCloseTo(0.4);
  });

  it('backfills reading positions when upgrading a v4 database', async () => {
    await resetReaderDbForTests();
    const legacy = parsedNovel('legacy-novel', '예전 책').novel;
    await createLegacyV4Database({
      ...legacy,
      lastReadChapterId: 'legacy-novel:chapter:9',
      lastReadParagraphId: 'legacy-novel:paragraph:12',
      lastReadOffset: 320,
      lastReadProgress: 0.48,
    });

    expect(await getReadingPosition('legacy-novel')).toMatchObject({
      novelId: 'legacy-novel',
      chapterId: 'legacy-novel:chapter:9',
      paragraphId: 'legacy-novel:paragraph:12',
      scrollTop: 320,
      chapterProgress: 0.48,
    });
    expect(await getNovel('legacy-novel')).toMatchObject({
      rawText: '',
      normalizedText: '',
    });
  });

  it('moves a novel to trash, restores it, and only purges children after confirmation', async () => {
    await saveImportedNovel(parsedNovel('novel-a', '첫 책'));
    await saveImportedNovel(parsedNovel('novel-b', '둘째 책'));
    await saveBookmark({
      id: 'bookmark-a',
      novelId: 'novel-a',
      chapterId: 'novel-a:chapter:1',
      label: '삭제될 북마크',
      progress: 0.2,
      scrollTop: 20,
      createdAt: '2026-07-04T00:02:00.000Z',
    });
    await saveHighlight({
      id: 'highlight-a',
      novelId: 'novel-a',
      chapterId: 'novel-a:chapter:1',
      paragraphId: 'novel-a:paragraph:1',
      quote: '첫 문단',
      color: 'yellow',
      progress: 0.2,
      createdAt: '2026-07-04T00:02:30.000Z',
      updatedAt: '2026-07-04T00:02:30.000Z',
    });

    await deleteNovel('novel-a');

    const trashed = await getNovel('novel-a');
    expect(trashed?.deletedAt).toBeTruthy();
    expect((await getNovels()).map((novel) => novel.id)).toEqual(['novel-b']);
    expect((await getTrashedNovels()).map((novel) => novel.id)).toEqual(['novel-a']);
    expect(await getChapters('novel-a')).toHaveLength(1);
    expect(await getParagraphPages('novel-a:chapter:1')).toHaveLength(1);
    expect(await getBookmarks('novel-a')).toHaveLength(1);
    expect(await getHighlights('novel-a')).toHaveLength(1);
    expect((await listSyncOutbox('pending')).map((item) => item.event.type)).toContain('book_trashed');

    await restoreNovelFromTrash('novel-a', trashed?.metadataRevision);
    expect((await getNovels()).map((novel) => novel.id).sort()).toEqual(['novel-a', 'novel-b']);
    const restored = await getNovel('novel-a');
    expect(restored?.deletedAt).toBeUndefined();

    await deleteNovel('novel-a');
    const trashedAgain = await getNovel('novel-a');
    await purgeNovel('novel-a', trashedAgain?.metadataRevision);

    expect(await getNovel('novel-a')).toBeUndefined();
    expect(await getChapters('novel-a')).toEqual([]);
    expect(await getParagraphPages('novel-a:chapter:1')).toEqual([]);
    expect(await getParagraphs('novel-a:chapter:1')).toEqual([]);
    expect(await getParagraphSearchRows('novel-a')).toEqual([]);
    expect(await getBookmarks('novel-a')).toEqual([]);
    expect(await getHighlights('novel-a')).toEqual([]);
    expect(await getNovel('novel-b')).toBeDefined();
    expect(await getChapters('novel-b')).toHaveLength(1);
    expect((await listSyncOutbox('pending')).map((item) => item.event.type)).toContain('book_purged');
  });
});
