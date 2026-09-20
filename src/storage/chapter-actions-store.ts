import type { Chapter, Novel } from '../domain/types';
import {
  contentRevisionComponentIds,
  ContentRevisionConflictError,
  type BookContentRevisionRecord,
} from './content-revisions';
import type { RevisionChapterRow } from './content-revision-store';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';

/** Titles are metadata: preserve chapter IDs, text, annotations, and resume positions. */
export async function renameChapter(
  novelId: string,
  chapterId: string,
  title: string,
  expectedContentRevisionId?: string,
): Promise<void> {
  title = title.trim();
  if (!title || title.length > 200) throw new Error('제목을 1~200자로 입력해 주세요.');
  const db = await openReaderDb();
  const tx = db.transaction(['novels', 'chapters', 'book_content_chapters', 'book_content_revisions'], 'readwrite');
  const done = transactionDone(tx);
  try {
    const novel = await requestToPromise<Novel | undefined>(tx.objectStore('novels').get(novelId));
    if (!novel || novel.activeContentRevisionId !== expectedContentRevisionId)
      throw new ContentRevisionConflictError('회차가 변경되었습니다. 다시 열어 주세요.');
    const revision = novel.activeContentRevisionId
      ? await requestToPromise<BookContentRevisionRecord | undefined>(
          tx.objectStore('book_content_revisions').get(novel.activeContentRevisionId),
        )
      : undefined;
    const components = new Set(revision ? contentRevisionComponentIds(revision) : [novel.activeContentRevisionId]);
    const store = tx.objectStore('book_content_chapters');
    const rows = await requestToPromise<RevisionChapterRow[]>(store.index('domainId').getAll(chapterId));
    const active = rows.filter((row) => row.novelId === novelId && components.has(row.contentRevisionId));
    const legacyStore = tx.objectStore('chapters');
    const legacy = await requestToPromise<Chapter | undefined>(legacyStore.get(chapterId));
    if (!active.length && (novel.activeContentRevisionId || legacy?.novelId !== novelId))
      throw new Error('회차를 찾을 수 없습니다.');
    const updatedAt = new Date().toISOString();
    active.forEach((row) => store.put({ ...row, title, updatedAt }));
    if (legacy?.novelId === novelId) legacyStore.put({ ...legacy, title, updatedAt });
    await done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* The transaction may already have failed. */
    }
    await done.catch(() => undefined);
    throw error;
  }
}
