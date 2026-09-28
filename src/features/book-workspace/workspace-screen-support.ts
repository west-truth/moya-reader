import type {
  ExternalSourceController,
  ExternalSourceLibraryWork,
} from '../external-sources/useExternalSourceController';
import type { LibraryFilter, LibrarySort } from '../library/library-screen-model';
import { useScreenMotion } from '../navigation/screen-motion';
import type { BookWorkspaceState } from './book-workspace-contract';

/** Remote library works only appear in unfiltered, unshelved library views that match the query. */
export function visibleRemoteLibraryWorks(
  works: readonly ExternalSourceLibraryWork[],
  view: { shelved: boolean; filter: LibraryFilter; query: string; sort: LibrarySort },
): ExternalSourceLibraryWork[] {
  if (view.shelved || (view.filter !== 'all' && view.filter !== 'unread')) return [];
  const query = view.query.trim().toLocaleLowerCase();
  return works
    .filter(
      (work) =>
        !query ||
        [work.title, work.author, work.sourceLabel]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLocaleLowerCase().includes(query)),
    )
    .sort((left, right) => {
      if (view.sort === 'title') return left.title.localeCompare(right.title, 'ko');
      if (view.sort === 'added') return right.createdAt.localeCompare(left.createdAt);
      return right.updatedAt.localeCompare(left.updatedAt);
    });
}

/** Library-level screens are siblings; a book is one level deeper and its reader one more. */
export function useWorkspaceScreenMotion(
  state: Pick<BookWorkspaceState, 'view' | 'selectedNovel'>,
  sources: Pick<ExternalSourceController, 'open' | 'activeSourceId' | 'localSeriesNovel'>,
  discoveryActive = false,
): void {
  const reading = state.view === 'reader' || state.view === 'document';
  const key =
    state.view !== 'library'
      ? `${reading ? 'reader' : state.view}:${state.selectedNovel?.id ?? ''}`
      : sources.open
        ? `source:${sources.activeSourceId ?? ''}:${sources.localSeriesNovel?.id ?? ''}`
        : discoveryActive
          ? 'discovery'
          : 'library';
  const depth = reading ? 2 : state.view === 'chapters' || (sources.open && sources.localSeriesNovel) ? 1 : 0;
  useScreenMotion(key, depth);
}
