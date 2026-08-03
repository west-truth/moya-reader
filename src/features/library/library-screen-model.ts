import type { Novel } from '../../domain/types';
import { formatDateTime } from '../../utils/format';

export type LibraryFilter = 'all' | 'reading' | 'finished' | 'unread' | 'favorite' | 'trash';
export type LibrarySort = 'recent' | 'title' | 'added';
export type LibraryViewMode = 'grid' | 'list';

export interface NovelReadStateSelectors {
  hasReadActivity(novel: Novel): boolean;
  isFinished(novel: Novel): boolean;
}

export interface LibraryBookView {
  novel: Novel;
  coverClass: string;
  isFinished: boolean;
  isUnread: boolean;
  readingStatusLabel: '완독' | '읽는 중' | '미독';
  readingTimeLabel: string;
  lastReadLabel: string;
}

export interface LibraryCollectionModel {
  totalBooks: number;
  visibleBooks: LibraryBookView[];
  recentBooks: LibraryBookView[];
  featuredBook?: LibraryBookView;
  booksByNovelId: ReadonlyMap<string, LibraryBookView>;
  filterCounts: Record<LibraryFilter, number>;
}

export interface BuildLibraryCollectionInput {
  novels: readonly Novel[];
  query: string;
  filter: LibraryFilter;
  sort: LibrarySort;
  readState: NovelReadStateSelectors;
}

function formatReadingDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  if (minutes > 0) return `${minutes}분 ${remainingSeconds}초`;
  return `${remainingSeconds}초`;
}

function activityAt(book: LibraryBookView): string {
  return book.novel.lastReadAt ?? book.novel.updatedAt;
}

function matchesFilter(book: LibraryBookView, filter: LibraryFilter): boolean {
  if (filter === 'trash') return Boolean(book.novel.deletedAt);
  if (book.novel.deletedAt) return false;
  if (filter === 'all') return true;
  if (filter === 'favorite') return book.novel.favorite;
  if (filter === 'finished') return book.isFinished;
  if (filter === 'unread') return book.isUnread;
  return !book.isFinished && !book.isUnread;
}

export function buildLibraryBookView(novel: Novel, readState: NovelReadStateSelectors): LibraryBookView {
  const isFinished = readState.isFinished(novel);
  const isUnread = !readState.hasReadActivity(novel);
  const readingSeconds = novel.readingSeconds ?? 0;

  return {
    novel,
    coverClass: `cover-${(novel.coverSeed % 6) + 1}`,
    isFinished,
    isUnread,
    readingStatusLabel: isFinished ? '완독' : isUnread ? '미독' : '읽는 중',
    readingTimeLabel: readingSeconds > 0 ? formatReadingDuration(readingSeconds) : '기록 없음',
    lastReadLabel: novel.lastReadAt ? formatDateTime(novel.lastReadAt) : '읽은 기록 없음',
  };
}

export function buildLibraryCollectionModel(input: BuildLibraryCollectionInput): LibraryCollectionModel {
  const books = input.novels.map((novel) => buildLibraryBookView(novel, input.readState));
  const activeBooks = books.filter((book) => !book.novel.deletedAt);
  const booksByNovelId = new Map(books.map((book) => [book.novel.id, book]));
  const query = input.query.trim().toLocaleLowerCase();
  const visibleBooks = books
    .filter((book) => matchesFilter(book, input.filter))
    .filter((book) => {
      if (!query) return true;
      const { novel } = book;
      return [novel.title, novel.author, novel.seriesTitle, ...(novel.tags ?? []), novel.sourceFileName]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(query));
    })
    .sort((a, b) => {
      if (input.sort === 'title') return a.novel.title.localeCompare(b.novel.title, 'ko');
      if (input.sort === 'added') return b.novel.createdAt.localeCompare(a.novel.createdAt);
      return activityAt(b).localeCompare(activityAt(a));
    });
  const recentBooks = activeBooks
    .filter((book) => !book.isUnread)
    .sort((a, b) => activityAt(b).localeCompare(activityAt(a)))
    .slice(0, 5);
  const filterCounts: Record<LibraryFilter, number> = {
    all: activeBooks.length,
    reading: 0,
    finished: 0,
    unread: 0,
    favorite: 0,
    trash: books.length - activeBooks.length,
  };

  activeBooks.forEach((book) => {
    if (book.novel.favorite) filterCounts.favorite += 1;
    if (book.isFinished) filterCounts.finished += 1;
    else if (book.isUnread) filterCounts.unread += 1;
    else filterCounts.reading += 1;
  });

  return {
    totalBooks: activeBooks.length,
    visibleBooks,
    recentBooks,
    featuredBook: recentBooks[0],
    booksByNovelId,
    filterCounts,
  };
}
