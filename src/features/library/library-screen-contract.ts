import type { DragEventHandler } from 'react';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { Novel } from '../../domain/types';
import type { LibraryCollectionModel, LibraryFilter, LibrarySort, LibraryViewMode } from './library-screen-model';
import type { Shelf } from '../../domain/types';
import type { BatchLibraryCommand, BatchLibraryReceipt } from '../../repositories/library-catalog-repository';
import type { ResponsiveLayoutMode } from '../book-workspace/useResponsiveLayoutMode';
import type { ImportTaskView } from '../import/import-task-projection';

type MaybePromise = void | Promise<void>;

export interface LibraryExternalWorkView {
  readonly id: string;
  readonly title: string;
  readonly author?: string;
  readonly thumbnailUrl?: string;
  readonly sourceLabel?: string;
  readonly availableReleaseCount: number;
  readonly newReleaseCount: number;
  readonly addedAt: string;
  readonly updatedAt: string;
}

export interface LibraryScreenModel {
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
  };
  filter: LibraryFilter;
  sort: LibrarySort;
  viewMode: LibraryViewMode;
  collection: LibraryCollectionModel;
  importTasks: readonly ImportTaskView[];
  presentation: {
    layoutMode: ResponsiveLayoutMode;
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
    setQuery(value: string): void;
    retryBootstrap(): void;
    openSync(): void;
    openSettings(): void;
    openBackup(): void;
    openImport(): void;
    openLibraryFolders(): void;
    openExternalSource(sourceId: ExtensionContributionId): void;
    openExternalSourceSettings(): void;
  };
  presentation: {
    goHome(): void;
    focusBook(novel: Novel): void;
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
    addSample(): MaybePromise;
    editMetadata(novel: Novel): void;
    toggleSelected(novel: Novel): void;
    openExternal(workId: string): MaybePromise;
    removeExternal(workId: string): MaybePromise;
  };
  imports: {
    open(task?: ImportTaskView): void;
    dismiss(taskId: string): void;
  };
}

export interface LibraryScreenProps {
  model: LibraryScreenModel;
  actions: LibraryScreenActions;
}
