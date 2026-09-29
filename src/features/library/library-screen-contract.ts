import type { DragEventHandler, ReactNode } from 'react';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { ExternalSourceBrowseMode } from '../../external-sources/contracts';
import type { Novel } from '../../domain/types';
import type { LibraryCollectionModel, LibraryFilter, LibrarySort, LibraryViewMode } from './library-screen-model';
import type { Shelf } from '../../domain/types';
import type { BatchLibraryCommand, BatchLibraryReceipt } from '../../repositories/library-catalog-repository';
import type { ResponsiveLayoutMode } from '../book-workspace/useResponsiveLayoutMode';
import type { ImportTaskView } from '../import/import-task-projection';

type MaybePromise = void | Promise<void>;

export interface LibraryExternalWorkView {
  readonly deletedAt?: string;
  readonly id: string;
  readonly title: string;
  readonly author?: string;
  readonly thumbnailUrl?: string;
  readonly sourceLabel?: string;
  readonly availableReleaseCount: number;
  /** Releases read out of `availableReleaseCount`. */
  readonly readReleaseCount?: number;
  /** Latest visit to any release; decides between continuing and starting from the first release. */
  readonly lastReadAt?: string;
  readonly newReleaseCount: number;
  readonly addedAt: string;
  readonly updatedAt: string;
}

export interface LibraryScreenModel {
  discovery?: { active: boolean; scope: string };
  bootstrap: {
    status: 'loading' | 'ready' | 'failed';
    message?: string;
  };
  drop: {
    active: boolean;
    importBusy: boolean;
  };
  query: string;
  sync: {
    label: string;
    tone: string;
  };
  externalSources: {
    bookReadingActivity?: ReadonlyMap<string, { readonly lastReadAt?: string }>;
    libraryBootstrap?: { status: 'loading' | 'ready' | 'failed'; message?: string };
    active: boolean;
    activeSourceId?: ExtensionContributionId;
    busy: boolean;
    sources: readonly {
      id: ExtensionContributionId;
      title: string;
      kind: 'cloud_file' | 'catalog';
      newReleaseCount?: number;
    }[];
    libraryWorks?: readonly LibraryExternalWorkView[];
    browse?: {
      readonly activeMode: ExternalSourceBrowseMode;
      readonly availableModes: readonly ExternalSourceBrowseMode[];
    };
  };
  filter: LibraryFilter;
  sort: LibrarySort;
  viewMode: LibraryViewMode;
  collection: LibraryCollectionModel;
  importTasks: readonly ImportTaskView[];
  presentation: {
    layoutMode: ResponsiveLayoutMode;
    showReadingCounts?: boolean;
    focusedBookId?: string;
    inspectorOpen: boolean;
    shelfBookCounts: ReadonlyMap<string, number>;
  };
  management: {
    available: boolean;
    shelves: readonly Shelf[];
    activeShelfId?: string;
    selectionMode: boolean;
    selectedBookIds: ReadonlySet<string>;
    busy: boolean;
    lastBatchReceipt?: BatchLibraryReceipt;
  };
}

export interface LibraryScreenActions {
  drag: {
    enter: DragEventHandler<HTMLElement>;
    over: DragEventHandler<HTMLElement>;
    leave: DragEventHandler<HTMLElement>;
    drop: DragEventHandler<HTMLElement>;
    dropOnEmptyState: DragEventHandler<HTMLDivElement>;
  };
  header: {
    openDiscovery?(): void;
    saveDiscoveryList?(): void;
    setQuery(value: string): void;
    retryBootstrap(): void;
    retrySourceLibrary?(): void;
    openSync(): void;
    openSettings(): void;
    openBackup(): void;
    openImport(): void;
    openLibraryFolders(): void;
    openExternalSource(sourceId: ExtensionContributionId): void;
    openExternalSourceBrowse(
      sourceId: ExtensionContributionId,
      mode: Exclude<ExternalSourceBrowseMode, 'search'>,
    ): void;
    openExternalSourceSettings(): void;
  };
  presentation: {
    goHome(): void;
    focusBook(novel: Novel): void;
    previewBook(novel: Novel): void;
    keepInspectorOpen(): void;
    closeInspectorSoon(): void;
    closeInspector(): void;
  };
  controls: {
    setFilter(filter: LibraryFilter): void;
    setSort(sort: LibrarySort): void;
    setViewMode(mode: LibraryViewMode): void;
    emptyTrash(): MaybePromise;
    setShelf(shelfId?: string): void;
    openShelves(): void;
    startSelection(): void;
    selectVisible(): void;
    clearSelection(): void;
    applyBatch(command: BatchLibraryCommand): Promise<BatchLibraryReceipt | undefined>;
    exportSelectedMetadata(): void;
  };
  books: {
    open(novel: Novel): MaybePromise;
    continueReading(novel: Novel): MaybePromise;
    toggleFavorite(novel: Novel): MaybePromise;
    remove(novel: Novel): MaybePromise;
    restore(novel: Novel): MaybePromise;
    purge(novel: Novel): MaybePromise;
    downloadSource(novel: Novel): MaybePromise;
    downloadFromMenu?(novel: Novel): MaybePromise;
    canDownloadFromMenu?(novel: Novel): boolean;
    addSample(): MaybePromise;
    editMetadata(novel: Novel): void;
    moveToShelf?(novel: Novel): void;
    rename?(novel: Novel): void;
    renameExternal?(id: string): void;
    moveExternalToShelf?(id: string): void;
    downloadExternal?(id: string): MaybePromise;
    toggleSelected(novel: Novel): void;
    toggleSelectedExternal?(id: string): void;
    openExternal(workId: string): MaybePromise;
    /** Resume the last visited release of a streamed work, or open its first release. */
    continueExternal?(workId: string): MaybePromise;
    removeExternal(workId: string): MaybePromise;
    restoreExternal?(workId: string): MaybePromise;
    purgeExternal?(workId: string): MaybePromise;
  };
  imports: {
    open(task?: ImportTaskView): void;
    dismiss(taskId: string): void;
  };
}

export interface LibraryScreenProps {
  model: LibraryScreenModel;
  actions: LibraryScreenActions;
  notice?: ReactNode;
}
