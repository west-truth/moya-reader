import type { ExternalSourceItemView } from './useExternalSourceController';

export const SOURCE_RELEASE_PAGE_SIZE = 10;
export type ReleaseReadFilter = 'all' | 'unread' | 'read';
export type ReleaseSort = 'asc' | 'desc';

export function filterAndSortReleases(
  items: readonly ExternalSourceItemView[],
  query: string,
  readFilter: ReleaseReadFilter,
  sort: ReleaseSort,
): ExternalSourceItemView[] {
  const search = query.normalize('NFKC').trim().toLocaleLowerCase();
  const order = (item: ExternalSourceItemView) => {
    const chapter = item.release?.chapterNumber;
    return chapter !== undefined && Number.isFinite(chapter) && chapter >= 0 ? chapter : item.release?.sourceOrder;
  };
  return items
    .filter((item) => {
      const read = item.readingState === 'read';
      if (readFilter === 'read' && !read) return false;
      if (readFilter === 'unread' && read) return false;
      return !search || `${item.title} ${order(item) ?? ''}화`.normalize('NFKC').toLocaleLowerCase().includes(search);
    })
    .sort((a, b) => {
      // A local section index is not a remote chapter number. Keep local-only
      // entries after the remote catalog, in their own independently sorted group.
      if (Boolean(a.localOrderOnly) !== Boolean(b.localOrderOnly)) return a.localOrderOnly ? 1 : -1;
      const left = order(a);
      const right = order(b);
      if (left === undefined || right === undefined) {
        if (left === right) return 0;
        return left === undefined ? 1 : -1;
      }
      return (left - right) * (sort === 'asc' ? 1 : -1);
    });
}

export function paginateReleases(items: readonly ExternalSourceItemView[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(items.length / SOURCE_RELEASE_PAGE_SIZE));
  const page = Math.min(pageCount, Math.max(1, Math.floor(requestedPage) || 1));
  return {
    page,
    pageCount,
    rangeStart: items.length ? (page - 1) * SOURCE_RELEASE_PAGE_SIZE + 1 : 0,
    rangeEnd: Math.min(page * SOURCE_RELEASE_PAGE_SIZE, items.length),
    items: items.slice((page - 1) * SOURCE_RELEASE_PAGE_SIZE, page * SOURCE_RELEASE_PAGE_SIZE),
  };
}
