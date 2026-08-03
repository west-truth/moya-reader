import type { DragEventHandler } from 'react';
import type { Novel } from '../../domain/types';
import type { LibraryCollectionModel, LibraryFilter, LibrarySort, LibraryViewMode } from './library-screen-model';
import type { Shelf } from '../../domain/types';
import type { BatchLibraryCommand, BatchLibraryReceipt } from '../../repositories/library-catalog-repository';
import type { ResponsiveLayoutMode } from '../book-workspace/useResponsiveLayoutMode';

type MaybePromise = void | Promise<void>;

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
  filter: LibraryFilter;
  sort: LibrarySort;
  viewMode: LibraryViewMode;
  collection: LibraryCollectionModel;
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
  };
  presentation: {
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
  };
}

export interface LibraryScreenProps {
  model: LibraryScreenModel;
  actions: LibraryScreenActions;
}
