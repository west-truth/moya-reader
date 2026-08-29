import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { LibraryScreenActions, LibraryScreenModel } from '../library/library-screen-contract';
import { LibraryHeader, LibraryMobileHeader, LibrarySidebar } from '../library/LibraryChrome';
import { LibraryScreen } from '../library/LibraryScreen';
import type { BookWorkspaceController } from './book-workspace-controller';
import type { BookWorkspaceProjection } from './book-workspace-projection';
import type { BookWorkspaceState } from './book-workspace-contract';
import type { LibraryManagementController } from '../library/useLibraryManagementController';
import type { BookEnrichmentController } from '../book-enrichment/useBookEnrichmentController';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';
import { useResponsiveLayoutMode } from './useResponsiveLayoutMode';

const ChaptersScreen = lazy(() =>
  import('../chapters/ChaptersScreen').then((module) => ({ default: module.ChaptersScreen })),
);
const LibraryManagementPanel = lazy(() => import('../library/LibraryManagementPanel'));
const SourceHubScreen = lazy(() => import('../external-sources/SourceHubScreen'));

export interface BookWorkspaceScreensProps {
  readonly controller: BookWorkspaceController;
  readonly state: BookWorkspaceState;
  readonly projection: BookWorkspaceProjection;
  readonly libraryDrop: {
    readonly active: boolean;
    readonly importBusy: boolean;
    readonly actions: LibraryScreenActions['drag'];
  };
  readonly bootstrap: {
    readonly status: 'loading' | 'ready' | 'failed';
    readonly message?: string;
    retry(): void;
  };
  readonly sync: { readonly label: string; readonly tone: string };
  readonly annotationTotals: {
    readonly bookmarks: number;
    readonly highlights: number;
    readonly notes: number;
  };
  readonly openSync: () => void;
  readonly openSettings: () => void;
  readonly openBackup: () => void;
  readonly openImport: () => void;
  readonly openChapterAppend: (novel: import('../../domain/types').Novel) => void;
  readonly openLibraryFolders: () => void;
  readonly externalSources: ExternalSourceController;
  readonly openExternalSourceSettings: () => void;
  readonly addSample: () => void | Promise<void>;
  readonly exportSource: (novel: import('../../domain/types').Novel) => void | Promise<void>;
  readonly reselectSource: (novel: import('../../domain/types').Novel, file: File) => void | Promise<void>;
  readonly reconstructSource: (novel: import('../../domain/types').Novel) => void | Promise<void>;
  readonly openChapterStructure: (bookId: string) => void | Promise<void>;
  readonly libraryManagement: LibraryManagementController;
  readonly bookEnrichment: BookEnrichmentController;
}

export function BookWorkspaceScreens({
  controller,
  state,
  projection,
  libraryDrop,
  bootstrap,
  sync,
  annotationTotals,
  openSync,
  openSettings,
  openBackup,
  openImport,
  openChapterAppend,
  openLibraryFolders,
  externalSources,
  openExternalSourceSettings,
  addSample,
  exportSource,
  reselectSource,
  reconstructSource,
  openChapterStructure,
  libraryManagement,
  bookEnrichment,
}: BookWorkspaceScreensProps) {
  const layoutMode = useResponsiveLayoutMode();
  const [focusedBookId, setFocusedBookId] = useState<string>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const activeShelfBookIds = useMemo(
    () =>
      libraryManagement.activeShelfId
        ? new Set(
            libraryManagement.memberships
              .filter((membership) => membership.shelfId === libraryManagement.activeShelfId)
              .map((membership) => membership.bookId),
          )
        : undefined,
    [libraryManagement.activeShelfId, libraryManagement.memberships],
  );
  const shelfBookCounts = useMemo(() => {
    const activeBookIds = new Set(state.novels.filter((novel) => !novel.deletedAt).map((novel) => novel.id));
    const counts = new Map<string, number>();
    libraryManagement.memberships.forEach((membership) => {
      if (!activeBookIds.has(membership.bookId)) return;
      counts.set(membership.shelfId, (counts.get(membership.shelfId) ?? 0) + 1);
    });
    return counts;
  }, [libraryManagement.memberships, state.novels]);
  const connectedExternalSources = useMemo(
    () => externalSources.sources.filter((source) => source.connection.state === 'connected'),
    [externalSources.sources],
  );
  const remoteLibraryWorks = useMemo(
    () => externalSources.libraryWorks.filter((work) => !work.localBookId),
    [externalSources.libraryWorks],
  );
  const visibleRemoteLibraryWorks = useMemo(() => {
    if (activeShelfBookIds || (state.libraryFilter !== 'all' && state.libraryFilter !== 'unread')) return [];
    const query = state.libraryQuery.trim().toLocaleLowerCase();
    return remoteLibraryWorks
      .filter(
        (work) =>
          !query ||
          [work.title, work.author, work.sourceLabel]
            .filter((value): value is string => Boolean(value))
            .some((value) => value.toLocaleLowerCase().includes(query)),
      )
      .sort((left, right) => {
        if (state.librarySort === 'title') return left.title.localeCompare(right.title, 'ko');
        if (state.librarySort === 'added') return right.createdAt.localeCompare(left.createdAt);
        return right.updatedAt.localeCompare(left.updatedAt);
      });
  }, [activeShelfBookIds, remoteLibraryWorks, state.libraryFilter, state.libraryQuery, state.librarySort]);
  const libraryCollection = useMemo(() => {
    const base = activeShelfBookIds
      ? {
          ...projection.libraryCollection,
          visibleBooks: projection.libraryCollection.visibleBooks.filter((book) =>
            activeShelfBookIds.has(book.novel.id),
          ),
        }
      : projection.libraryCollection;
    return {
      ...base,
      totalBooks: base.totalBooks + remoteLibraryWorks.length,
      filterCounts: {
        ...base.filterCounts,
        all: base.filterCounts.all + remoteLibraryWorks.length,
        unread: base.filterCounts.unread + remoteLibraryWorks.length,
      },
    };
  }, [activeShelfBookIds, projection.libraryCollection, remoteLibraryWorks.length]);

  useEffect(() => {
    if (state.view !== 'library') return;
    if (focusedBookId && libraryCollection.visibleBooks.some((book) => book.novel.id === focusedBookId)) return;
    const featuredVisible = libraryCollection.visibleBooks.find(
      (book) => book.novel.id === libraryCollection.featuredBook?.novel.id,
    );
    setFocusedBookId(featuredVisible?.novel.id ?? libraryCollection.visibleBooks[0]?.novel.id);
  }, [focusedBookId, libraryCollection.featuredBook?.novel.id, libraryCollection.visibleBooks, state.view]);

  useEffect(() => {
    if (layoutMode === 'mobile') setInspectorOpen(false);
  }, [layoutMode]);

  const focusBook = (novel: import('../../domain/types').Novel) => {
    setFocusedBookId(novel.id);
    if (layoutMode === 'compact') setInspectorOpen(true);
  };

  const goLibraryHome = () => {
    if (externalSources.busy) return;
    externalSources.close();
    controller.setLibraryQuery('');
    controller.setLibraryFilter('all');
    libraryManagement.setActiveShelf(undefined);
    if (libraryManagement.selectionMode) libraryManagement.clearSelection();
    setInspectorOpen(false);
    controller.setView('library');
  };

  const openLibraryNovel = (novel: import('../../domain/types').Novel) => {
    if (novel.format === 'image_archive') {
      controller.replaceSelection({
        selectedNovel: novel,
        chapters: [],
        currentChapter: undefined,
        localReadingPosition: undefined,
        remoteReadingPosition: undefined,
      });
      controller.setView('library');
      void externalSources.showLocalSeries(novel);
      return;
    }
    externalSources.close();
    void controller.openNovel(novel);
  };

  const libraryModel: LibraryScreenModel = {
    bootstrap: { status: bootstrap.status, message: bootstrap.message },
    drop: libraryDrop,
    query: state.libraryQuery,
    sync,
    externalSources: {
      active: externalSources.open,
      activeSourceId: externalSources.activeSourceId,
      busy: externalSources.busy,
      sources: connectedExternalSources.map((source) => ({
        id: source.id,
        title: source.title,
        kind: source.kind,
        newReleaseCount: source.newReleaseCount,
      })),
      libraryWorks: visibleRemoteLibraryWorks.map((work) => ({
        id: work.id,
        title: work.title,
        author: work.author,
        thumbnailUrl: work.thumbnailUrl,
        sourceLabel: work.sourceLabel,
        availableReleaseCount: work.availableReleaseCount,
        newReleaseCount: work.newReleaseIds.length,
        addedAt: work.createdAt,
        updatedAt: work.updatedAt,
      })),
    },
    filter: state.libraryFilter,
    sort: state.librarySort,
    viewMode: state.libraryViewMode,
    collection: libraryCollection,
    presentation: {
      layoutMode,
      focusedBookId,
      inspectorOpen: layoutMode === 'wide' || inspectorOpen,
      shelfBookCounts,
    },
    management: {
      available: libraryManagement.available,
      shelves: libraryManagement.shelves,
      activeShelfId: libraryManagement.activeShelfId,
      selectionMode: libraryManagement.selectionMode,
      selectedBookIds: libraryManagement.selectedBookIds,
      busy: libraryManagement.busy,
      lastBatchReceipt: libraryManagement.lastBatchReceipt,
    },
  };

  const libraryActions: LibraryScreenActions = {
    drag: libraryDrop.actions,
    header: {
      setQuery: controller.setLibraryQuery,
      retryBootstrap: bootstrap.retry,
      openSync,
      openSettings,
      openBackup,
      openImport,
      openLibraryFolders,
      openExternalSource: (sourceId) => {
        if (externalSources.busy) return;
        controller.setView('library');
        externalSources.show(sourceId);
      },
      openExternalSourceSettings,
    },
    presentation: {
      goHome: goLibraryHome,
      focusBook,
      closeInspector: () => setInspectorOpen(false),
    },
    controls: {
      setFilter: (filter) => {
        if (externalSources.busy) return;
        externalSources.close();
        controller.setView('library');
        controller.setLibraryFilter(filter);
      },
      setSort: controller.setLibrarySort,
      setViewMode: controller.setLibraryViewMode,
      emptyTrash: controller.emptyTrash,
      setShelf: (shelfId) => {
        if (externalSources.busy) return;
        externalSources.close();
        controller.setView('library');
        libraryManagement.setActiveShelf(shelfId);
      },
      openShelves: libraryManagement.openShelves,
      startSelection: libraryManagement.startSelection,
      selectVisible: () => libraryManagement.selectBooks(libraryCollection.visibleBooks.map((book) => book.novel.id)),
      clearSelection: libraryManagement.clearSelection,
      applyBatch: (command) => libraryManagement.applyBatch(command, state.novels),
      exportSelectedMetadata: () => libraryManagement.exportSelectedMetadata(state.novels),
    },
    books: {
      open: openLibraryNovel,
      continueReading: controller.continueReading,
      toggleFavorite: controller.toggleFavorite,
      remove: controller.removeNovel,
      restore: controller.restoreNovel,
      purge: controller.purgeNovel,
      downloadSource: exportSource,
      addSample,
      editMetadata: libraryManagement.openMetadata,
      toggleSelected: (novel) => libraryManagement.toggleSelected(novel.id),
      openExternal: async (workId) => {
        const work = externalSources.libraryWorks.find((candidate) => candidate.id === workId);
        if (!work) return;
        controller.setView('library');
        await externalSources.openSubscription(work);
      },
      removeExternal: async (workId) => {
        const work = externalSources.libraryWorks.find((candidate) => candidate.id === workId);
        if (work) await externalSources.removeLibraryWork(work);
      },
    },
  };

  return (
    <>
      {state.view === 'library' && !externalSources.open && (
        <LibraryScreen model={libraryModel} actions={libraryActions} />
      )}

      {state.view === 'library' && externalSources.open && (
        <Suspense fallback={null}>
          <SourceHubScreen
            controller={externalSources}
            library={{ model: libraryModel, actions: libraryActions }}
            openSourceSettings={openExternalSourceSettings}
            openLocalSeriesImport={openChapterAppend}
            localSeriesNovel={
              externalSources.localSeriesNovel && state.selectedNovel?.id === externalSources.localSeriesNovel.id
                ? state.selectedNovel
                : externalSources.localSeriesNovel
            }
            localSeriesTitleEditor={
              externalSources.localSeriesNovel && state.selectedNovel?.id === externalSources.localSeriesNovel.id
                ? {
                    editing: state.bookTitleEditing,
                    draft: state.bookTitleDraft,
                    start: controller.startBookTitleEdit,
                    cancel: controller.cancelBookTitleEdit,
                    setDraft: controller.setBookTitleDraft,
                    save: controller.saveBookTitle,
                  }
                : undefined
            }
          />
        </Suspense>
      )}

      {state.view === 'chapters' && state.selectedNovel && projection.selectedNovelScreenBook && (
        <main className="library-screen book-detail-product-screen">
          <div className="library-product-shell">
            <LibrarySidebar model={libraryModel} actions={libraryActions} />
            <section className="library-workspace book-detail-workspace">
              <LibraryMobileHeader model={libraryModel} actions={libraryActions} />
              <LibraryHeader model={libraryModel} actions={libraryActions} />
              <Suspense fallback={null}>
                <ChaptersScreen
                  model={{
                    book: projection.selectedNovelScreenBook,
                    titleEditor: { editing: state.bookTitleEditing, draft: state.bookTitleDraft },
                    query: state.chapterQuery,
                    readFilter: state.chapterReadFilter,
                    sort: state.chapterSort,
                    chapterList: projection.chapterList,
                    summary: {
                      readChapterProgress: projection.readChapterProgress,
                      readLocationLabel: projection.readLocationLabel,
                      bookmarkCount: annotationTotals.bookmarks,
                      highlightCount: annotationTotals.highlights,
                      noteCount: annotationTotals.notes,
                      syncLabel: sync.label,
                      firstUnreadChapter: projection.firstUnreadChapter,
                      currentReadTargetChapter: projection.currentReadTargetChapter,
                      canMarkCurrentChapterRead: projection.canMarkCurrentChapterRead,
                      canMarkBookFinished: projection.canMarkBookFinished,
                      canResetBookProgress: projection.canResetBookProgress,
                    },
                  }}
                  actions={{
                    navigation: {
                      backToLibrary: () => controller.setView('library'),
                      continueReading: () => controller.continueReading(),
                      openSettings,
                      openSync,
                      openImport,
                      openChapterAppend: () => openChapterAppend(state.selectedNovel!),
                      openStructureEditor: () => void openChapterStructure(state.selectedNovel!.id),
                      openMetadata: () => libraryManagement.openMetadata(state.selectedNovel!),
                    },
                    titleEditor: {
                      start: controller.startBookTitleEdit,
                      cancel: controller.cancelBookTitleEdit,
                      setDraft: controller.setBookTitleDraft,
                      save: controller.saveBookTitle,
                    },
                    book: {
                      toggleFavorite: controller.toggleFavorite,
                      openFirstUnreadChapter: controller.openFirstUnreadChapter,
                      markCurrentChapterRead: controller.markCurrentChapterRead,
                      markFinished: controller.markBookFinished,
                      resetProgress: controller.resetBookProgress,
                      exportSource,
                      reselectSource,
                      reconstructSource,
                    },
                    chapterList: {
                      setQuery: controller.setChapterQuery,
                      setReadFilter: controller.setChapterReadFilter,
                      setSort: controller.setChapterSort,
                      openChapter: controller.openChapterFromList,
                    },
                  }}
                />
              </Suspense>
            </section>
          </div>
        </main>
      )}
      {libraryManagement.panel && (
        <Suspense fallback={null}>
          <LibraryManagementPanel controller={libraryManagement} bookEnrichment={bookEnrichment} />
        </Suspense>
      )}
    </>
  );
}
