import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { integrityHash } from '../domain/id-hash-contract';
import type { Chapter, Novel, Paragraph, ParagraphPage } from '../domain/types';
import {
  createAppendDeltaContentRevisionComposition,
  type BookContentRevisionRecord,
  type StoredContentRevisionCounts,
} from './content-revisions';
import {
  contentDomainHeadId,
  type ContentDomainHead,
  type RevisionChapterRow,
  type RevisionParagraphPageRow,
  type RevisionParagraphRefRow,
  type RevisionParagraphSearchRow,
} from './content-revision-store';
import {
  getActiveContentRevisionDiagnostics,
  getRevisionChapters,
  getRevisionParagraphPages,
  openBookContentRevision,
} from './content-revision-read-handle';
import { revisionScopedStorageId } from './content-revisions';
import { openReaderDb, resetReaderDbForTests } from './reader-database';
import {
  getChapter,
  getChapters,
  getParagraph,
  getParagraphPages,
  searchBookParagraphs,
  searchParagraphs,
} from './reader-query-store';

const BOOK_ID = 'book-composite';
const BASE_REVISION_ID = 'revision-base';
const DELTA_REVISION_ID = 'revision-delta';
const NEXT_REVISION_ID = 'revision-next';
const NOW = '2026-08-26T00:00:00.000Z';

const oneChapterCounts: StoredContentRevisionCounts = {
  chapterCount: 1,
  pageCount: 1,
  paragraphCount: 1,
  paragraphRefCount: 1,
  searchRowCount: 1,
};

function logicalCounts(chapterCount: number): StoredContentRevisionCounts {
  return {
    chapterCount,
    pageCount: chapterCount,
    paragraphCount: chapterCount,
    paragraphRefCount: chapterCount,
    searchRowCount: chapterCount,
  };
}

function revision(
  id: string,
  status: BookContentRevisionRecord['status'],
  baseActiveRevisionId?: string,
): BookContentRevisionRecord {
  return {
    id,
    novelId: BOOK_ID,
    status,
    source: 'local_import',
    baseActiveRevisionId,
    baseNovelPresent: Boolean(baseActiveRevisionId),
    expected: oneChapterCounts,
    actual: oneChapterCounts,
    createdAt: NOW,
    activatedAt: NOW,
  };
}

function novel(activeContentRevisionId: string, totalChapters: number): Novel {
  return {
    id: BOOK_ID,
    format: 'txt',
    title: '증분 작품',
    sourceFileName: '증분 작품.moya.zip',
    sourceEncoding: 'utf-8',
    rawText: '',
    normalizedText: '',
    rawTextHash: integrityHash('source'),
    normalizedTextHash: integrityHash(`normalized-${totalChapters}`),
    activeContentRevisionId,
    createdAt: NOW,
    updatedAt: NOW,
    totalChapters,
    totalCharacters: totalChapters * 10,
    totalParagraphs: totalChapters,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
  };
}

function contentRows(contentRevisionId: string, index: number, text: string) {
  const chapter: Chapter = {
    id: `chapter-${index}`,
    novelId: BOOK_ID,
    index,
    title: `${index}화`,
    normalizedText: '',
    textHash: integrityHash(text),
    rawStartOffset: (index - 1) * 20,
    rawEndOffset: (index - 1) * 20 + text.length,
    characterCount: text.length,
    paragraphCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const paragraph: Paragraph = {
    id: `paragraph-${index}`,
    novelId: BOOK_ID,
    chapterId: chapter.id,
    index: 1,
    text,
    startOffsetInChapter: 0,
    endOffsetInChapter: text.length,
    textHash: integrityHash(text),
  };
  const page: ParagraphPage = {
    id: `page-${index}`,
    novelId: BOOK_ID,
    chapterId: chapter.id,
    pageIndex: 0,
    startParagraphIndex: 1,
    endParagraphIndex: 1,
    paragraphs: [paragraph],
    textHash: integrityHash(JSON.stringify([paragraph.textHash])),
  };
  return {
    chapter,
    paragraph,
    chapterRow: {
      ...chapter,
      storageId: revisionScopedStorageId(contentRevisionId, chapter.id),
      contentRevisionId,
    } satisfies RevisionChapterRow,
    paragraphRow: {
      ...paragraph,
      text: '',
      pageIndex: 0,
      textStorageMode: 'page',
      storageId: revisionScopedStorageId(contentRevisionId, paragraph.id),
      contentRevisionId,
    } satisfies RevisionParagraphRefRow,
    pageRow: {
      ...page,
      storageId: revisionScopedStorageId(contentRevisionId, page.id),
      contentRevisionId,
    } satisfies RevisionParagraphPageRow,
    searchRow: {
      id: `search-${index}`,
      novelId: BOOK_ID,
      chapterId: chapter.id,
      paragraphId: paragraph.id,
      pageId: page.id,
      pageIndex: 0,
      paragraphIndex: 1,
      paragraph,
      storageId: revisionScopedStorageId(contentRevisionId, `search-${index}`),
      contentRevisionId,
    } satisfies RevisionParagraphSearchRow,
    chapterHead: {
      id: contentDomainHeadId('chapter', chapter.id),
      entityType: 'chapter',
      domainId: chapter.id,
      novelId: BOOK_ID,
      contentRevisionId,
    } satisfies ContentDomainHead,
  };
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function putCompositeState(input: {
  activeRevision: BookContentRevisionRecord;
  revisions: readonly BookContentRevisionRecord[];
  rows: readonly ReturnType<typeof contentRows>[];
}): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(
    [
      'novels',
      'book_content_revisions',
      'book_content_chapters',
      'book_content_paragraphs',
      'book_content_paragraph_pages',
      'book_content_paragraph_search',
      'book_content_domain_heads',
    ],
    'readwrite',
  );
  tx.objectStore('novels').put(
    novel(input.activeRevision.id, input.activeRevision.composition?.logicalCounts.chapterCount ?? 1),
  );
  input.revisions.forEach((record) => tx.objectStore('book_content_revisions').put(record));
  input.rows.forEach((row) => {
    tx.objectStore('book_content_chapters').put(row.chapterRow);
    tx.objectStore('book_content_paragraphs').put(row.paragraphRow);
    tx.objectStore('book_content_paragraph_pages').put(row.pageRow);
    tx.objectStore('book_content_paragraph_search').put(row.searchRow);
    tx.objectStore('book_content_domain_heads').put(row.chapterHead);
  });
  await transactionDone(tx);
}

describe('composite content revision reads', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('flattens append compositions and requires the owner revision as the last component', () => {
    const base = revision(BASE_REVISION_ID, 'superseded');
    const firstComposition = createAppendDeltaContentRevisionComposition({
      revisionId: DELTA_REVISION_ID,
      baseRevision: base,
      logicalCounts: logicalCounts(2),
    });
    const first = { ...revision(DELTA_REVISION_ID, 'superseded', BASE_REVISION_ID), composition: firstComposition };
    const secondComposition = createAppendDeltaContentRevisionComposition({
      revisionId: NEXT_REVISION_ID,
      baseRevision: first,
      logicalCounts: logicalCounts(3),
    });

    expect(firstComposition.componentRevisionIds).toEqual([BASE_REVISION_ID, DELTA_REVISION_ID]);
    expect(secondComposition.componentRevisionIds).toEqual([BASE_REVISION_ID, DELTA_REVISION_ID, NEXT_REVISION_ID]);
  });

  it('reads all components while an opened handle stays pinned to its original physical chapter map', async () => {
    const base = revision(BASE_REVISION_ID, 'superseded');
    const delta = {
      ...revision(DELTA_REVISION_ID, 'active', BASE_REVISION_ID),
      composition: createAppendDeltaContentRevisionComposition({
        revisionId: DELTA_REVISION_ID,
        baseRevision: base,
        logicalCounts: logicalCounts(2),
      }),
    } satisfies BookContentRevisionRecord;
    const baseRows = contentRows(BASE_REVISION_ID, 1, '공통 검색어 첫 번째 본문');
    const deltaRows = contentRows(DELTA_REVISION_ID, 2, '공통 검색어 두 번째 본문');
    await putCompositeState({ activeRevision: delta, revisions: [base, delta], rows: [baseRows, deltaRows] });

    const db = await openReaderDb();
    const pinned = await openBookContentRevision(db, BOOK_ID);
    expect((await getRevisionChapters(db, DELTA_REVISION_ID)).map((chapter) => chapter.id)).toEqual([
      baseRows.chapter.id,
      deltaRows.chapter.id,
    ]);
    expect((await getRevisionParagraphPages(db, DELTA_REVISION_ID, baseRows.chapter.id))[0]?.paragraphs[0]?.text).toBe(
      baseRows.paragraph.text,
    );
    expect((await getChapters(BOOK_ID)).map((chapter) => chapter.id)).toEqual([
      baseRows.chapter.id,
      deltaRows.chapter.id,
    ]);
    await expect(getChapter(baseRows.chapter.id)).resolves.toMatchObject({ id: baseRows.chapter.id });
    await expect(getParagraph(baseRows.paragraph.id)).resolves.toMatchObject({ text: baseRows.paragraph.text });
    await expect(getParagraphPages(deltaRows.chapter.id)).resolves.toHaveLength(1);
    await expect(searchParagraphs(baseRows.chapter.id, '첫 번째')).resolves.toHaveLength(1);
    await expect(searchBookParagraphs(BOOK_ID, '공통 검색어')).resolves.toHaveLength(2);

    const next = {
      ...revision(NEXT_REVISION_ID, 'active', DELTA_REVISION_ID),
      composition: createAppendDeltaContentRevisionComposition({
        revisionId: NEXT_REVISION_ID,
        baseRevision: delta,
        logicalCounts: logicalCounts(3),
      }),
    } satisfies BookContentRevisionRecord;
    const nextRows = contentRows(NEXT_REVISION_ID, 3, '공통 검색어 세 번째 본문');
    await putCompositeState({
      activeRevision: next,
      revisions: [{ ...delta, status: 'superseded' }, next],
      rows: [nextRows],
    });

    expect((await pinned.listChapters()).map((chapter) => chapter.id)).toEqual([
      baseRows.chapter.id,
      deltaRows.chapter.id,
    ]);
    await expect(pinned.listParagraphPages(nextRows.chapter.id)).resolves.toEqual([]);
    expect((await getChapters(BOOK_ID)).map((chapter) => chapter.id)).toEqual([
      baseRows.chapter.id,
      deltaRows.chapter.id,
      nextRows.chapter.id,
    ]);
    const diagnostics = await getActiveContentRevisionDiagnostics(db, BOOK_ID);
    expect(diagnostics).toMatchObject({ contentRevisionId: NEXT_REVISION_ID, revision: { id: NEXT_REVISION_ID } });
    expect(diagnostics.paragraphPages).toHaveLength(3);
    expect(diagnostics.paragraphRefs).toHaveLength(3);
    expect(diagnostics.paragraphSearchRows).toHaveLength(3);
  });
});
