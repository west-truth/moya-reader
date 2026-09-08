import { useCallback, useLayoutEffect, useRef } from 'react';
import type { Novel } from '../../domain/types';
import type { BookWorkspaceController } from '../book-workspace/book-workspace-controller';
import type { BookWorkspaceState } from '../book-workspace/book-workspace-contract';
import type {
  ExternalSourceController,
  ExternalSourceNavigationSnapshot,
} from '../external-sources/useExternalSourceController';
import { BrowserNavigation, installAppHistoryBack } from './browser-navigation';
import { openLibraryBook } from '../book-workspace/book-workspace-source-navigation';

type Snapshot = {
  view: BookWorkspaceState['view'];
  bookId?: string;
  detailBookId?: string;
  source?: ExternalSourceNavigationSnapshot;
  library: Pick<BookWorkspaceState, 'libraryQuery' | 'libraryFilter' | 'librarySort' | 'libraryViewMode'>;
  chapters: Pick<BookWorkspaceState, 'chapterQuery' | 'chapterReadFilter' | 'chapterSort'>;
  layers: readonly string[];
};

export function useAppBrowserNavigation(options: {
  enabled: boolean;
  workspace: BookWorkspaceController;
  state: BookWorkspaceState;
  sources: ExternalSourceController;
  getNovel(id: string): Promise<Novel | undefined>;
  layers?: readonly { id: string; open: boolean; dismiss(): void }[];
  notify(message: string): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const history = useRef<BrowserNavigation<Snapshot>>();
  const capture = useCallback(() => {
    const { state, sources, layers } = latest.current;
    const source = state.view === 'library' && sources.open ? sources.captureNavigation?.() : undefined;
    const snapshot: Snapshot = {
      view: state.view,
      bookId: state.selectedNovel?.id,
      source,
      library: {
        libraryQuery: state.libraryQuery,
        libraryFilter: state.libraryFilter,
        librarySort: state.librarySort,
        libraryViewMode: state.libraryViewMode,
      },
      chapters: {
        chapterQuery: state.chapterQuery,
        chapterReadFilter: state.chapterReadFilter,
        chapterSort: state.chapterSort,
      },
      layers: layers?.filter((layer) => layer.open && layer.id !== 'external-sources').map((layer) => layer.id) ?? [],
    };
    const key = JSON.stringify([
      state.view,
      state.view === 'library' ? undefined : snapshot.bookId,
      source && [source.sourceId, source.localBookId, source.breadcrumbs.map((item) => item.parentRef)],
      snapshot.layers,
    ]);
    return { key, snapshot };
  }, []);

  useLayoutEffect(() => {
    if (!options.enabled) return;
    const navigation = new BrowserNavigation<Snapshot>({
      window,
      initial: capture(),
      capture,
      closesLayer: (from, to) =>
        from.view === to.view &&
        from.bookId === to.bookId &&
        from.source?.sourceId === to.source?.sourceId &&
        from.source?.localBookId === to.source?.localBookId &&
        JSON.stringify(from.source?.breadcrumbs) === JSON.stringify(to.source?.breadcrumbs) &&
        from.layers.length > to.layers.length &&
        to.layers.every((id) => from.layers.includes(id)),
      intermediate: (from, to) => {
        if (
          (to.view !== 'reader' && to.view !== 'document') ||
          (from.view === to.view && from.bookId === to.bookId) ||
          from.source ||
          (from.view === 'chapters' && from.bookId === to.bookId)
        )
          return;
        return {
          key: `detail:${to.bookId}`,
          snapshot: { ...to, view: 'chapters', detailBookId: to.bookId, layers: [] },
        };
      },
      cancelPending: () => {
        latest.current.workspace.cancelNavigation();
        latest.current.sources.close();
      },
      settled: () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
      onError: () => {
        latest.current.sources.close();
        latest.current.workspace.setView('library');
        latest.current.notify('이전 화면을 열지 못해 라이브러리로 돌아왔습니다.');
      },
      restore: async (target, signal) => {
        const { workspace, sources } = latest.current;
        for (const layer of latest.current.layers ?? []) {
          if (layer.id !== 'external-sources' && layer.open && !target.layers.includes(layer.id)) layer.dismiss();
        }
        const current = workspace.getSnapshot();
        const sameReader =
          (current.view === 'reader' || current.view === 'document') &&
          current.view === target.view &&
          current.selectedNovel?.id === target.bookId;
        if (sameReader) return;
        if (current.view === 'reader' || current.view === 'document') await workspace.returnToChapters();
        signal.throwIfAborted();
        sources.close();
        if (target.view === 'library') {
          workspace.setLibraryQuery(target.library.libraryQuery);
          workspace.setLibraryFilter(target.library.libraryFilter);
          workspace.setLibrarySort(target.library.librarySort);
          workspace.setLibraryViewMode(target.library.libraryViewMode);
          workspace.setView('library');
          if (target.source) await latest.current.sources.restoreNavigation?.(target.source);
        } else {
          const novel = target.bookId ? await latest.current.getNovel(target.bookId) : undefined;
          signal.throwIfAborted();
          if (!novel || novel.deletedAt) {
            workspace.setView('library');
            return;
          }
          if (target.detailBookId) await openLibraryBook(novel, workspace, latest.current.sources);
          else if (target.view === 'reader' || target.view === 'document') await workspace.continueReading(novel);
          else {
            await workspace.openNovel(novel, target.chapters);
          }
        }
      },
    });
    history.current = navigation;
    const removeBack = installAppHistoryBack(() => navigation.back());
    return () => {
      removeBack();
      navigation.dispose();
      history.current = undefined;
    };
  }, [options.enabled, capture]);

  useLayoutEffect(() => {
    if (options.state.navigationPending || (options.sources.open && options.sources.loading)) return;
    history.current?.record(capture());
  });
}
