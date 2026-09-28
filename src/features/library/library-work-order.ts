import type { LibraryExternalWorkView } from './library-screen-contract';
import type { LibraryBookView, LibrarySort } from './library-screen-model';

export type LibraryWorkItem =
  | { kind: 'book'; key: string; book: LibraryBookView }
  | { kind: 'external'; key: string; work: LibraryExternalWorkView };

/** Storage type must never determine a work's position in the library. */
export function orderedLibraryWorks(
  books: readonly LibraryBookView[],
  externalWorks: readonly LibraryExternalWorkView[],
  sort: LibrarySort,
  sourceActivity?: ReadonlyMap<string, { readonly lastReadAt?: string }>,
): LibraryWorkItem[] {
  const items: LibraryWorkItem[] = [
    ...books.map((book) => ({ kind: 'book' as const, key: `book:${book.novel.id}`, book })),
    ...externalWorks.map((work) => ({ kind: 'external' as const, key: `external:${work.id}`, work })),
  ];
  const bookActivity = (book: LibraryBookView) => {
    const stream = sourceActivity?.get(book.novel.id)?.lastReadAt;
    const local = book.novel.lastReadAt;
    return stream && local ? (stream > local ? stream : local) : (stream ?? local ?? book.novel.updatedAt);
  };
  const fields = (item: LibraryWorkItem) =>
    item.kind === 'book'
      ? {
          title: item.book.novel.title,
          addedAt: item.book.novel.createdAt,
          activityAt: bookActivity(item.book),
        }
      : { title: item.work.title, addedAt: item.work.addedAt, activityAt: item.work.lastReadAt ?? item.work.updatedAt };
  return items.sort((left, right) => {
    const a = fields(left),
      b = fields(right);
    const order =
      sort === 'title'
        ? a.title.localeCompare(b.title, 'ko')
        : sort === 'added'
          ? b.addedAt.localeCompare(a.addedAt)
          : b.activityAt.localeCompare(a.activityAt);
    return order || a.title.localeCompare(b.title, 'ko') || left.key.localeCompare(right.key);
  });
}
