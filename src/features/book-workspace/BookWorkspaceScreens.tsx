import { libraryShelfMemberships } from './library-shelf-memberships';
import { useLibraryWorkActions } from './use-library-work-actions';
import { externalSelectionId } from '../library/library-batch';
import type { SourceTextReaderOptions } from '../external-sources/SourceTextStreamReader';
import { SaveDiscoveryList } from '../discovery/SaveDiscoveryList';
import type { DiscoveryController } from '../discovery/useDiscoveryController';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { ExternalSourceListInput } from '../../external-sources/contracts';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { importTaskIsActive, type ImportTaskView } from '../import/import-task-projection';
import { continueLibraryBook, openLibraryBook } from './book-workspace-source-navigation';
import { navigateAppBack } from '../navigation/browser-navigation';
import { applySourceProgress, withSourceProgress } from '../library/library-source-progress';
import {
  useWorkspaceScreenMotion,
  visibleRemoteLibraryWorks,
  remoteLibraryReadCounts,
} from './workspace-screen-support';
import { BookDetailSkeleton, useIdleScreenPreload, WorkspaceScreenSkeleton } from './WorkspaceSkeletons';

const ChaptersScreen = lazy(() =>
  import('../chapters/ChaptersScreen').then((module) => ({ default: module.ChaptersScreen })),
);
const LibraryManagementPanel = lazy(() => import('../library/LibraryManagementPanel'));
const DiscoveryScreen = lazy(() => import('../discovery/DiscoveryScreen'));
const SourceHubScreen = lazy(() => import('../external-sources/SourceHubScreen'));

export interface BookWorkspaceScreensProps {
  readonly discovery?: DiscoveryController;
  readonly libraryNotice?: ReactNode;
  readonly textReader?: SourceTextReaderOptions;
  readonly controller: BookWorkspaceController;
  readonly state: BookWorkspaceState;
  readonly projection: BookWorkspaceProjection;
  readonly libraryDrop: {
    readonly active: boolean;
    readonly importBusy: boolean;
    readonly actions: LibraryScreenActions['drag'];
  };
  readonly importTasks: readonly ImportTaskView[];
  readonly dismissImportTask: (taskId: string) => void;
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
  discovery,
  libraryNotice,
  textReader,
  controller,
  state,
  projection,
  libraryDrop,
  importTasks,
  dismissImportTask,
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
  useWorkspaceScreenMotion(state, externalSources, discovery?.active);
  useIdleScreenPreload(bootstrap.status === 'ready');
  const [saveListOpen, setSaveListOpen] = useState(false);
  const [focusedBookId, setFocusedBookId] = useState<string>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const inspectorCloseTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const keepInspectorOpen = () => {
    if (inspectorCloseTimer.current !== undefined) globalThis.clearTimeout(inspectorCloseTimer.current);
    inspectorCloseTimer.current = undefined;
  };
  const closeInspector = () => {
    keepInspectorOpen();
    setInspectorOpen(false);
  };
  const closeInspectorSoon = () => {
    if (layoutMode !== 'compact') return;
    keepInspectorOpen();
    inspectorCloseTimer.current = globalThis.setTimeout(() => setInspectorOpen(false), 140);
  };
  const workActions = useLibraryWorkActions(externalSources, libraryManagement);
  const shelfMemberships = useMemo(
    () => libraryShelfMemberships(libraryManagement.memberships, externalSources.libraryWorks),
    [libraryManagement.memberships, externalSources.libraryWorks],
  );
  const activeShelfBookIds = useMemo(
    () =>
      libraryManagement.activeShelfId
        ? new Set(
            shelfMemberships
              .filter((membership) => membership.shelfId === libraryManagement.activeShelfId)
              .map((membership) => membership.bookId),
          )
        : undefined,
    [libraryManagement.activeShelfId, shelfMemberships],
  );
  const shelfBookCounts = useMemo(() => {
    const activeBookIds = new Set(state.novels.filter((novel) => !novel.deletedAt).map((novel) => novel.id));
    const counts = new Map<string, number>();
    externalSources.libraryWorks.forEach((work) => {
      if (!work.deletedAt && !work.localBookId) activeBookIds.add(externalSelectionId(work.id));
    });
    shelfMemberships.forEach((membership) => {
      if (!activeBookIds.has(membership.bookId)) return;
      counts.set(membership.shelfId, (counts.get(membership.shelfId) ?? 0) + 1);
    });
    return counts;
  }, [shelfMemberships, state.novels, externalSources.libraryWorks]);
  const connectedExternalSources = useMemo(
    () => externalSources.sources.filter((source) => source.connection.state === 'connected'),
    [externalSources.sources],
  );
  const remoteLibraryWorks = useMemo(
    () => externalSources.libraryWorks.filter((work) => !work.localBookId),
    [externalSources.libraryWorks],
  );
  const remoteWorksInView = useMemo(
    () =>
      visibleRemoteLibraryWorks(
        remoteLibraryWorks,
        {
          shelved: Boolean(activeShelfBookIds),
          shelfId: libraryManagement.activeShelfId,
          filter: state.libraryFilter,
          query: state.libraryQuery,
          sort: state.librarySort,
        },
        externalSources.sourceWorkProgress?.bySubscriptionId,
      ),
    [
      activeShelfBookIds,
      libraryManagement.activeShelfId,
      remoteLibraryWorks,
      state.libraryFilter,
      state.libraryQuery,
      state.librarySort,
      externalSources.sourceWorkProgress,
    ],
  );
  // Source works count read releases against the source's list unless downloads are chosen in settings.
  const sourceProgress =
    textReader?.settings.sourceProgressBasis === 'downloaded' ? undefined : externalSources.sourceWorkProgress;
  const libraryCollection = useMemo(() => {
    const progressed = applySourceProgress(projection.libraryCollection, sourceProgress?.byNovelId);
    const base = activeShelfBookIds
      ? {
          ...progressed,
          visibleBooks: progressed.visibleBooks.filter((book) => activeShelfBookIds.has(book.novel.id)),
        }
      : progressed;
    const remoteCounts = remoteLibraryReadCounts(
      remoteLibraryWorks,
      externalSources.sourceWorkProgress?.bySubscriptionId,
    );
    return {
      ...base,
      totalBooks: base.totalBooks + remoteLibraryWorks.filter((work) => !work.deletedAt).length,
      filterCounts: {
        ...base.filterCounts,
        all: base.filterCounts.all + remoteLibraryWorks.filter((work) => !work.deletedAt).length,
        trash: base.filterCounts.trash + remoteLibraryWorks.filter((work) => work.deletedAt).length,
        unread: base.filterCounts.unread + remoteCounts.unread,
        reading: base.filterCounts.reading + remoteCounts.reading,
        finished: base.filterCounts.finished + remoteCounts.finished,
      },
    };
  }, [
    activeShelfBookIds,
    projection.libraryCollection,
    remoteLibraryWorks,
    sourceProgress,
    externalSources.sourceWorkProgress,
  ]);
  const bookHasActiveImport = (bookId: string) =>
    importTasks.some((task) => task.targetBookId === bookId && importTaskIsActive(task));
  const externalWorkHasActiveImport = (workId: string) =>
    importTasks.some((task) => task.externalWorkId === workId && importTaskIsActive(task));

  useEffect(() => {
    if (state.view !== 'library') return;
    if (focusedBookId && libraryCollection.visibleBooks.some((book) => book.novel.id === focusedBookId)) return;
    const featuredVisible = libraryCollection.visibleBooks.find(
      (book) => book.novel.id === libraryCollection.featuredBook?.novel.id,
    );
    setFocusedBookId(featuredVisible?.novel.id ?? libraryCollection.visibleBooks[0]?.novel.id);
  }, [focusedBookId, libraryCollection.featuredBook?.novel.id, libraryCollection.visibleBooks, state.view]);

  useEffect(() => {
    if (layoutMode === 'mobile' || state.view !== 'library') setInspectorOpen(false);
    return () => {
      if (inspectorCloseTimer.current !== undefined) globalThis.clearTimeout(inspectorCloseTimer.current);
      inspectorCloseTimer.current = undefined;
    };
  }, [layoutMode, state.view]);

  const focusBook = (novel: import('../../domain/types').Novel) => {
    setFocusedBookId(novel.id);
  };

  const previewBook = (novel: import('../../domain/types').Novel) => {
    if (layoutMode !== 'wide') return;
    keepInspectorOpen();
    setFocusedBookId(novel.id);
  };

  const goLibraryHome = () => {
    discovery?.setActive(false);
    externalSources.close();
    controller.setLibraryQuery('');
    controller.setLibraryFilter('all');
    if (libraryManagement.selectionMode) libraryManagement.clearSelection();
    closeInspector();
    controller.setView('library');
  };

  const openLibraryNovel = (novel: import('../../domain/types').Novel) => {
    closeInspector();
    void openLibraryBook(novel, controller, externalSources);
  };

  const libraryModel: LibraryScreenModel = {
    discovery: discovery ? { active: discovery.active && !externalSources.open, scope: discovery.scope } : undefined,
    bootstrap,
    drop: libraryDrop,
    query: state.libraryQuery,
    sync,
    externalSources: {
      libraryBootstrap: externalSources.libraryBootstrap,
      bookReadingActivity: externalSources.sourceWorkProgress?.byNovelId,
      active: externalSources.open,
      activeSourceId: externalSources.activeSourceId,
      busy: externalSources.busy,
      sources: connectedExternalSources.map((source) => ({
        id: source.id,
        title: source.title,
        kind: source.kind,
        newReleaseCount: source.newReleaseCount,
      })),
      libraryWorks: remoteWorksInView.map((work) => ({
        id: work.id,
        title: work.title,
        author: work.author,
        thumbnailUrl: work.thumbnailUrl,
        sourceLabel: work.sourceLabel,
        availableReleaseCount: work.availableReleaseCount,
        // Streamed-only works have nothing downloaded, so they always count against the source.
        readReleaseCount: externalSources.sourceWorkProgress?.bySubscriptionId.get(work.id)?.readCount,
        lastReadAt: externalSources.sourceWorkProgress?.bySubscriptionId.get(work.id)?.lastReadAt,
        newReleaseCount: work.newReleaseIds.length,
        addedAt: work.createdAt,
        updatedAt: work.updatedAt,
        deletedAt: work.deletedAt,
      })),
      browse: externalSources.catalogBrowse
        ? {
            activeMode: externalSources.catalogBrowse.activeMode,
            availableModes: externalSources.catalogBrowse.availableModes,
          }
        : undefined,
    },
    filter: state.libraryFilter,
    sort: state.librarySort,
    viewMode: state.libraryViewMode,
    collection: libraryCollection,
    importTasks,
    presentation: {
      layoutMode,
      showReadingCounts: textReader?.settings.showLibraryReadingCounts === true,
      showFormatBadge: textReader?.settings.showLibraryFormatBadge !== false,
      focusedBookId,
      inspectorOpen: layoutMode === 'wide' || inspectorOpen,
      shelfBookCounts,
    },
    management: {
      available: libraryManagement.available || Boolean(externalSources.batchLibraryTrash),
      shelves: libraryManagement.shelves,
      activeShelfId: libraryManagement.activeShelfId,
      selectionMode: libraryManagement.selectionMode,
      selectedBookIds: libraryManagement.selectedBookIds,
      busy: libraryManagement.busy || externalSources.busy,
      lastBatchReceipt: libraryManagement.lastBatchReceipt,
    },
  };

  const libraryActions: LibraryScreenActions = {
    drag: libraryDrop.actions,
    header: {
      saveDiscoveryList: discovery ? () => setSaveListOpen(true) : undefined,
      openDiscovery: discovery
        ? () => {
            externalSources.close();
            discovery.setActive(true);
            controller.setView('library');
          }
        : undefined,
      setQuery: controller.setLibraryQuery,
      retryBootstrap: bootstrap.retry,
      retrySourceLibrary: () => void externalSources.retryLibrary?.(),
      openSync,
      openSettings,
      openBackup,
      openImport,
      openLibraryFolders,
      openExternalSource: (sourceId) => {
        discovery?.setActive(false);
        controller.setView('library');
        externalSources.show(sourceId);
      },
      openExternalSourceBrowse: (sourceId, mode) => {
        if (externalSources.activeSourceId !== sourceId) return;
        controller.setView('library');
        void externalSources.openCatalogBrowse(mode);
      },
      openExternalSourceSettings,
    },
    presentation: {
      goHome: goLibraryHome,
      focusBook,
      previewBook,
      keepInspectorOpen,
      closeInspectorSoon,
      closeInspector,
    },
    controls: {
      setFilter: (filter) => {
        discovery?.setActive(false);
        externalSources.close();
        controller.setView('library');
        controller.setLibraryFilter(filter);
      },
      setSort: controller.setLibrarySort,
      setViewMode: controller.setLibraryViewMode,
      emptyTrash: () => controller.emptyTrash(externalSources.emptyLibraryTrash),
      setShelf: (shelfId) => {
        discovery?.setActive(false);
        externalSources.close();
        controller.setView('library');
        libraryManagement.setActiveShelf(shelfId);
      },
      openShelves: libraryManagement.openShelves,
      startSelection: libraryManagement.startSelection,
      selectVisible: () =>
        libraryManagement.selectBooks([
          ...libraryCollection.visibleBooks
            .filter((book) => !bookHasActiveImport(book.novel.id))
            .map((book) => book.novel.id),
          ...remoteWorksInView
            .filter((work) => !externalWorkHasActiveImport(work.id))
            .map((work) => externalSelectionId(work.id)),
        ]),
      clearSelection: libraryManagement.clearSelection,
      applyBatch: (command) =>
        libraryManagement.applyBatch(
          command,
          state.novels.filter((book) => !bookHasActiveImport(book.id)),
          externalSources.batchLibraryTrash
            ? {
                ids: externalSources.libraryWorks
                  .filter((work) => !externalWorkHasActiveImport(work.id))
                  .map((work) => work.id),
                apply: externalSources.batchLibraryTrash,
                linkedBooks: externalSources.libraryWorks
                  .filter((work) => work.localBookId && !work.deletedAt)
                  .map((work) => ({ id: work.id, bookId: work.localBookId! })),
                setShelfMembership: externalSources.updateLibraryMetadata
                  ? (id, shelfId, included) =>
                      externalSources.updateLibraryMetadata!(id, { shelfMembership: { shelfId, included } })
                  : undefined,
              }
            : undefined,
        ),
      exportSelectedMetadata: () => libraryManagement.exportSelectedMetadata(state.novels),
    },
    books: {
      open: openLibraryNovel,
      continueReading: (novel) => continueLibraryBook(novel, controller, externalSources),
      toggleFavorite: (novel) => (bookHasActiveImport(novel.id) ? undefined : controller.toggleFavorite(novel)),
      remove: (novel) => (bookHasActiveImport(novel.id) ? undefined : controller.removeNovel(novel)),
      restore: (novel) => (bookHasActiveImport(novel.id) ? undefined : controller.restoreNovel(novel)),
      purge: (novel) => (bookHasActiveImport(novel.id) ? undefined : controller.purgeNovel(novel)),
      downloadSource: exportSource,
      downloadFromMenu: async (novel) => {
        if (bookHasActiveImport(novel.id)) return;
        const work = externalSources.libraryWorks.find((work) => work.localBookId === novel.id);
        if (work) {
          controller.setView('library');
          await workActions.downloadExternal(work.id);
        } else await exportSource(novel);
      },
      canDownloadFromMenu: (novel) =>
        Boolean(novel.sourceAssetId || externalSources.libraryWorks.some((work) => work.localBookId === novel.id)),
      rename: libraryManagement.available ? workActions.rename : undefined,
      moveToShelf: libraryManagement.available ? workActions.moveToShelf : undefined,
      renameExternal: externalSources.updateLibraryMetadata ? workActions.renameExternal : undefined,
      moveExternalToShelf:
        libraryManagement.available && externalSources.updateLibraryMetadata
          ? workActions.moveExternalToShelf
          : undefined,
      downloadExternal: async (id) => {
        if (externalWorkHasActiveImport(id)) return;
        controller.setView('library');
        await workActions.downloadExternal(id);
      },
      addSample,
      editMetadata: (novel) => {
        if (!bookHasActiveImport(novel.id)) libraryManagement.openMetadata(novel);
      },
      toggleSelected: (novel) => {
        if (!bookHasActiveImport(novel.id)) libraryManagement.toggleSelected(novel.id);
      },
      toggleSelectedExternal: (id) => {
        if (!externalWorkHasActiveImport(id)) libraryManagement.toggleSelected(externalSelectionId(id));
      },
      openExternal: async (workId) => {
        const work = externalSources.libraryWorks.find((candidate) => candidate.id === workId);
        if (!work) return;
        controller.setView('library');
        await externalSources.openSubscription(work);
      },
      continueExternal: async (workId) => {
        controller.setView('library');
        await externalSources.continueLibraryWork(workId);
      },
      restoreExternal: (id) => externalSources.restoreLibraryWork?.(id),
      purgeExternal: (id) => externalSources.purgeLibraryWork?.(id),
      removeExternal: async (workId) => {
        if (externalWorkHasActiveImport(workId)) return;
        const work = externalSources.libraryWorks.find((candidate) => candidate.id === workId);
        if (work) await externalSources.removeLibraryWork(work);
      },
    },
    imports: {
      open: (task) => {
        if (task?.source !== 'external_source') {
          openImport();
          return;
        }
        const work = task.externalWorkId
          ? externalSources.libraryWorks.find((candidate) => candidate.id === task.externalWorkId)
          : undefined;
        if (work) {
          void externalSources.openSubscription(work);
          return;
        }
        externalSources.show(externalSources.activeSourceId);
      },
      dismiss: dismissImportTask,
    },
  };

  return (
    <>
      {workActions.dialog}
      {state.navigationPending && <div className="app-navigation-progress" aria-hidden="true" />}
      {saveListOpen && discovery && (
        <SaveDiscoveryList discovery={discovery} source={externalSources} close={() => setSaveListOpen(false)} />
      )}
      {state.view === 'library' && !externalSources.open && !discovery?.active && (
        <LibraryScreen model={libraryModel} actions={libraryActions} notice={libraryNotice} />
      )}

      {state.view === 'library' && !externalSources.open && discovery?.active && (
        <Suspense fallback={<WorkspaceScreenSkeleton model={libraryModel} actions={libraryActions} />}>
          <DiscoveryScreen
            library={{ model: libraryModel, actions: libraryActions }}
            discovery={discovery}
            sources={externalSources}
            open={(id: string, input: ExternalSourceListInput, title?: string) => {
              void externalSources.openDiscovery?.(id as ExtensionContributionId, input, title);
            }}
          />
        </Suspense>
      )}

      {state.view === 'library' && externalSources.open && (
        <Suspense fallback={<WorkspaceScreenSkeleton model={libraryModel} actions={libraryActions} />}>
          <SourceHubScreen
            downloadRequest={workActions.downloadRequest}
            textReader={textReader}
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
              <Suspense fallback={<BookDetailSkeleton />}>
                <ChaptersScreen
                  model={{
                    loading: state.navigationPending,
                    book: withSourceProgress(
                      projection.selectedNovelScreenBook,
                      sourceProgress?.byNovelId.get(projection.selectedNovelScreenBook.novel.id),
                    ),
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
                      canResetBookProgress:
                        projection.canResetBookProgress ||
                        Boolean(externalSources.sourceWorkProgress?.byNovelId.get(state.selectedNovel!.id)?.readCount),
                    },
                  }}
                  actions={{
                    navigation: {
                      backToLibrary: () => navigateAppBack(() => controller.setView('library')),
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
                      resetProgress: () =>
                        controller.resetBookProgress(
                          () => externalSources.clearBookSourceHistory?.(state.selectedNovel!) ?? Promise.resolve(),
                        ),
                      exportSource,
                      reselectSource,
                      reconstructSource,
                    },
                    chapterList: {
                      markRead: controller.markChapterListRead,
                      rename: controller.renameChapter,
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
