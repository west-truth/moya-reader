import { formatCount } from '../../utils/format';
import type { SourceWorkProgress } from '../external-sources/source-work-progress';
import type { LibraryExternalWorkView } from './library-screen-contract';
import type { LibraryBookView, LibraryCollectionModel } from './library-screen-model';

/** Shows a source work's progress against the source's full release list instead of its downloads. */
export function withSourceProgress(book: LibraryBookView, progress: SourceWorkProgress | undefined): LibraryBookView {
  if (!progress) return book;
  return {
    ...book,
    bookProgress: progress.progress,
    readingCounts: { current: progress.readCount, total: progress.totalCount, unit: '화' },
    readingPositionLabel: `${formatCount(progress.readCount)} / ${formatCount(progress.totalCount)}화`,
  };
}

/** Status, filters and sorting stay on the local book; only the progress presentation changes. */
export function applySourceProgress(
  collection: LibraryCollectionModel,
  byNovelId: ReadonlyMap<string, SourceWorkProgress> | undefined,
): LibraryCollectionModel {
  if (!byNovelId || byNovelId.size === 0) return collection;
  const replaced = new Map<LibraryBookView, LibraryBookView>();
  const apply = (book: LibraryBookView): LibraryBookView => {
    const progress = byNovelId.get(book.novel.id);
    if (!progress) return book;
    let next = replaced.get(book);
    if (!next) {
      next = withSourceProgress(book, progress);
      replaced.set(book, next);
    }
    return next;
  };
  return {
    ...collection,
    visibleBooks: collection.visibleBooks.map(apply),
    recentBooks: collection.recentBooks.map(apply),
    featuredBook: collection.featuredBook && apply(collection.featuredBook),
    booksByNovelId: new Map([...collection.booksByNovelId].map(([id, book]) => [id, apply(book)])),
  };
}

/** Remote works show releases read out of the source total once any have been read. */
export function externalWorkReleaseLabel(work: LibraryExternalWorkView): string {
  const total = formatCount(work.availableReleaseCount);
  return work.readReleaseCount ? `${formatCount(work.readReleaseCount)}/${total}화` : `${total}화`;
}

export function externalWorkListMeta(work: LibraryExternalWorkView): string {
  return [
    work.author,
    work.sourceLabel,
    `원격 회차 ${formatCount(work.availableReleaseCount)}개`,
    work.readReleaseCount ? `${formatCount(work.readReleaseCount)}화 읽음` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}
