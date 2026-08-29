import { hashSync } from '../domain/hash';
import type { Chapter, Novel, Paragraph, ParagraphPage } from '../domain/types';
import type { BulkParagraphPageRequest } from '../repositories/reader-repository';
import { throwIfReaderSearchAborted } from '../repositories/reader-query-contract';
import { PARAGRAPHS_PER_PAGE } from '../repositories/reader-defaults';
import {
  activeRevisionIdForChapter,
  getContentRevisionComponentIds,
  getContentDomainHead,
  getLegacyChapters,
  getLegacyParagraphPages,
  getLegacyParagraphs,
  getRevisionParagraphPage,
  getRevisionParagraphPages,
  getRevisionParagraphRefs,
  getLogicalRevisionChapters,
  iteratePinnedParagraphPages,
  legacyNovelIsReadable,
  readableLegacyChapter,
} from './content-revision-read-handle';
import {
  chapterFromRevisionRow,
  type ParagraphSearchRow,
  paragraphFromRevisionRow,
  type RevisionChapterRow,
  type RevisionParagraphPageRow,
  type RevisionParagraphRefRow,
  type RevisionParagraphSearchRow,
  type StoredParagraphRef,
} from './content-revision-store';
import { getAllByIndex, getAllRecords, getByIndex, getItem } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';
export { searchBookParagraphs, searchParagraphPage, searchParagraphs } from './reader-search-query-store';

export async function getNovels(): Promise<Novel[]> {
  const novels = await getAllRecords<Novel>('novels');
  return novels.filter((novel) => !novel.deletedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getTrashedNovels(): Promise<Novel[]> {
  const novels = await getAllRecords<Novel>('novels');
  return novels
    .filter((novel) => Boolean(novel.deletedAt))
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
}

export function getNovel(id: string): Promise<Novel | undefined> {
  return getItem<Novel>('novels', id);
}

export async function getChapters(novelId: string): Promise<Chapter[]> {
  const novel = await getNovel(novelId);
  const db = await openReaderDb();
  return novel?.activeContentRevisionId
    ? getLogicalRevisionChapters(db, novel.activeContentRevisionId)
    : getLegacyChapters(db, novelId);
}

export async function getChapter(id: string): Promise<Chapter | undefined> {
  const db = await openReaderDb();
  const contentRevisionId = await activeRevisionIdForChapter(db, id);
  if (contentRevisionId) {
    const row = await getByIndex<RevisionChapterRow>('book_content_chapters', 'contentRevisionId_domainId', [
      contentRevisionId,
      id,
    ]);
    return row ? chapterFromRevisionRow(row) : undefined;
  }
  return readableLegacyChapter(db, id);
}

export async function getParagraphs(chapterId: string): Promise<Paragraph[]> {
  const db = await openReaderDb();
  const contentRevisionId = await activeRevisionIdForChapter(db, chapterId);
  if (!contentRevisionId) {
    return (await readableLegacyChapter(db, chapterId)) ? getLegacyParagraphs(db, chapterId) : [];
  }
  const pages = await getRevisionParagraphPages(db, contentRevisionId, chapterId);
  if (pages.length) {
    return pages.flatMap((page) => page.paragraphs).sort((a, b) => a.index - b.index);
  }
  return getRevisionParagraphRefs(db, contentRevisionId, chapterId);
}

async function getParagraphsByIndexRange(
  chapterId: string,
  startIndex: number,
  endIndex: number,
): Promise<Paragraph[]> {
  const paragraphs = await getAllByIndex<Paragraph>(
    'paragraphs',
    'chapterId_index',
    IDBKeyRange.bound([chapterId, startIndex], [chapterId, endIndex]),
  );
  return paragraphs.sort((a, b) => a.index - b.index);
}

function getRevisionParagraphRefCandidates(db: IDBDatabase, paragraphId: string): Promise<RevisionParagraphRefRow[]> {
  const tx = db.transaction('book_content_paragraphs', 'readonly');
  const request = tx.objectStore('book_content_paragraphs').index('domainId').openCursor(paragraphId);
  return new Promise((resolve, reject) => {
    const candidates: RevisionParagraphRefRow[] = [];
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(candidates);
        return;
      }
      candidates.push(cursor.value as RevisionParagraphRefRow);
      cursor.continue();
    };
  });
}

function getRevisionParagraphPageCandidates(db: IDBDatabase, paragraphId: string): Promise<RevisionParagraphPageRow[]> {
  const tx = db.transaction('book_content_paragraph_pages', 'readonly');
  const request = tx.objectStore('book_content_paragraph_pages').index('paragraphIds').openCursor(paragraphId);
  return new Promise((resolve, reject) => {
    const candidates: RevisionParagraphPageRow[] = [];
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(candidates);
        return;
      }
      candidates.push(cursor.value as RevisionParagraphPageRow);
      cursor.continue();
    };
  });
}

export async function getParagraph(id: string): Promise<Paragraph | undefined> {
  const db = await openReaderDb();
  const head = await getContentDomainHead(db, 'paragraph', id);
  const [candidates, pageCandidates] = await Promise.all([
    getRevisionParagraphRefCandidates(db, id),
    getRevisionParagraphPageCandidates(db, id),
  ]);
  const novelIds = [
    ...new Set([
      ...(head ? [head.novelId] : []),
      ...candidates.map((candidate) => candidate.novelId),
      ...pageCandidates.map((candidate) => candidate.novelId),
    ]),
  ];
  let storedRef: RevisionParagraphRefRow | undefined;
  for (const novelId of novelIds) {
    const novel = await getNovel(novelId);
    if (!novel?.activeContentRevisionId) continue;
    const components = await getContentRevisionComponentIds(db, novel.activeContentRevisionId);
    for (const componentRevisionId of [...components].reverse()) {
      const page = pageCandidates.find(
        (candidate) => candidate.novelId === novelId && candidate.contentRevisionId === componentRevisionId,
      );
      const paragraph = page?.paragraphs.find((candidate) => candidate.id === id);
      if (paragraph) return paragraph;
      storedRef = candidates.find(
        (candidate) => candidate.novelId === novelId && candidate.contentRevisionId === componentRevisionId,
      );
      if (storedRef) break;
    }
    if (storedRef) break;
  }
  const contentRevisionId = storedRef?.contentRevisionId;
  if (contentRevisionId) {
    const row = await getByIndex<RevisionParagraphSearchRow>(
      'book_content_paragraph_search',
      'contentRevisionId_paragraphId',
      [contentRevisionId, id],
    );
    if (row?.paragraph) return row.paragraph;
    const stored =
      storedRef ??
      (await getByIndex<RevisionParagraphRefRow>('book_content_paragraphs', 'contentRevisionId_domainId', [
        contentRevisionId,
        id,
      ]));
    if (!stored) return undefined;
    if (stored.text) return paragraphFromRevisionRow(stored);
    if (typeof stored.pageIndex === 'number') {
      const page = await getRevisionParagraphPage(db, contentRevisionId, stored.chapterId, stored.pageIndex);
      return page?.paragraphs.find((paragraph) => paragraph.id === id) ?? paragraphFromRevisionRow(stored);
    }
    return paragraphFromRevisionRow(stored);
  }

  const searchRow = await getByIndex<ParagraphSearchRow>('paragraph_search', 'paragraphId', id);
  if (searchRow) return (await legacyNovelIsReadable(db, searchRow.novelId)) ? searchRow.paragraph : undefined;

  const stored = await getItem<StoredParagraphRef>('paragraphs', id);
  if (!stored) return undefined;
  if (!(await legacyNovelIsReadable(db, stored.novelId))) return undefined;
  if (stored.text) return stored;

  if (typeof stored.pageIndex === 'number') {
    const page = await getParagraphPage(stored.chapterId, stored.pageIndex);
    const paragraph = page?.paragraphs.find((item) => item.id === id);
    if (paragraph) return paragraph;
  }

  return stored;
}

export async function getParagraphPages(chapterId: string): Promise<ParagraphPage[]> {
  const db = await openReaderDb();
  const contentRevisionId = await activeRevisionIdForChapter(db, chapterId);
  if (contentRevisionId) return getRevisionParagraphPages(db, contentRevisionId, chapterId);
  return (await readableLegacyChapter(db, chapterId)) ? getLegacyParagraphPages(db, chapterId) : [];
}

export async function getParagraphPage(chapterId: string, pageIndex: number): Promise<ParagraphPage | undefined> {
  const db = await openReaderDb();
  const contentRevisionId = await activeRevisionIdForChapter(db, chapterId);
  if (contentRevisionId) return getRevisionParagraphPage(db, contentRevisionId, chapterId, pageIndex);
  if (!(await readableLegacyChapter(db, chapterId))) return undefined;
  const storedPage = await getByIndex<ParagraphPage>('paragraph_pages', 'chapterId_pageIndex', [chapterId, pageIndex]);
  if (storedPage) return storedPage;

  const startIndex = pageIndex * PARAGRAPHS_PER_PAGE + 1;
  const endIndex = startIndex + PARAGRAPHS_PER_PAGE - 1;
  const paragraphs = await getParagraphsByIndexRange(chapterId, startIndex, endIndex);
  if (!paragraphs.length) return undefined;

  return {
    id: `legacy_page_${chapterId}_${pageIndex}`,
    novelId: paragraphs[0].novelId,
    chapterId,
    pageIndex,
    startParagraphIndex: paragraphs[0].index,
    endParagraphIndex: paragraphs[paragraphs.length - 1].index,
    paragraphs,
    textHash: hashSync(paragraphs.map((paragraph) => paragraph.textHash).join(':')),
  };
}

export async function* iterateParagraphPages(request: BulkParagraphPageRequest): AsyncIterable<ParagraphPage> {
  throwIfReaderSearchAborted(request.signal);
  const db = await openReaderDb();
  const contentRevisionId = await activeRevisionIdForChapter(db, request.chapterId);
  throwIfReaderSearchAborted(request.signal);
  if (!contentRevisionId && !(await readableLegacyChapter(db, request.chapterId))) return;
  throwIfReaderSearchAborted(request.signal);
  yield* iteratePinnedParagraphPages(db, contentRevisionId, request);
}
