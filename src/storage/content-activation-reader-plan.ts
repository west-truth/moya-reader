import type { Novel } from '../domain/types';
import type { RemoteBookSnapshotStream } from '../sync/types';
import { getBookmarks, getHighlights, getNotes } from './annotation-store';
import { openBookContentRevision } from './content-revision-read-handle';
import {
  addParagraphPagesToChildIdIndex,
  addParagraphToChildIdIndex,
  type BookChildIdIndex,
  createBookChildIdIndex,
  prepareRemoteContentActivation,
} from './content-revision-remote-state';
import type { ContentActivationReaderPlan } from './content-revision-store';
import { getNovel } from './reader-query-store';
import { openReaderDb } from './reader-database';
import { getReadingPosition } from './reader-state-store';
import { getSyncState, listSyncOutbox, nowIso } from './sync-event-store';

export async function buildCachedBookChildIdIndex(novelId: string): Promise<BookChildIdIndex> {
  const novel = await getNovel(novelId);
  if (!novel) return createBookChildIdIndex([]);
  const handle = await openBookContentRevision(await openReaderDb(), novelId);
  const chapters = await handle.listChapters();
  const index = createBookChildIdIndex(chapters);
  for (const chapter of chapters) {
    const pages = await handle.listParagraphPages(chapter.id);
    if (pages.length) {
      addParagraphPagesToChildIdIndex(index, pages);
    } else {
      const paragraphs = await handle.listParagraphs(chapter.id);
      paragraphs.forEach((paragraph) => addParagraphToChildIdIndex(index, paragraph));
    }
  }
  return index;
}

export async function prepareContentActivationReaderPlan(
  snapshot: Pick<RemoteBookSnapshotStream, 'novel' | 'chapters' | 'readingPosition'>,
  oldIndex: BookChildIdIndex,
  nextIndex: BookChildIdIndex,
  targetContentRevisionId: string,
): Promise<{ novel: Novel; readerPlan: ContentActivationReaderPlan }> {
  const [baseNovel, readingPosition, bookmarks, highlights, notes, outboxItems, syncState] = await Promise.all([
    getNovel(snapshot.novel.id),
    getReadingPosition(snapshot.novel.id),
    getBookmarks(snapshot.novel.id),
    getHighlights(snapshot.novel.id),
    getNotes(snapshot.novel.id),
    listSyncOutbox(),
    getSyncState(),
  ]);
  return prepareRemoteContentActivation({
    snapshot,
    baseNovel,
    localSnapshot: { readingPosition, bookmarks, highlights, notes },
    outboxItems,
    oldIndex,
    nextIndex,
    expectedSyncNextSequence: syncState.nextSequence,
    now: nowIso(),
    sourceContentRevisionId: baseNovel?.activeContentRevisionId,
    targetContentRevisionId,
  });
}
