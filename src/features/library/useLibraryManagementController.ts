import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BookMetadataPatch } from '@noveldesk/text-core/library-metadata';
import type { Novel, Shelf, ShelfMembership } from '../../domain/types';
import type { BookAssetRepository, BookCoverAssetInput } from '../../repositories/book-asset-repository';
import type {
  BatchLibraryCommand,
  BatchLibraryReceipt,
  LibraryCatalogRepository,
} from '../../repositories/library-catalog-repository';
import { downloadLibraryMetadata } from './library-metadata-export';

export type LibraryManagementPanel = { kind: 'shelves' } | { kind: 'metadata'; book: Novel };
export type CoverDraftAction = { kind: 'keep' } | { kind: 'remove' } | { kind: 'replace'; input: BookCoverAssetInput };

export interface LibraryManagementController {
  readonly available: boolean;
  readonly shelves: readonly Shelf[];
  readonly memberships: readonly ShelfMembership[];
  readonly activeShelfId?: string;
  readonly selectionMode: boolean;
  readonly selectedBookIds: ReadonlySet<string>;
  readonly panel?: LibraryManagementPanel;
  readonly busy: boolean;
  readonly error?: string;
  readonly lastBatchReceipt?: BatchLibraryReceipt;
  refresh(): Promise<void>;
  setActiveShelf(shelfId?: string): void;
  openShelves(): void;
  openMetadata(book: Novel): void;
  confirmDiscard?(message: string): boolean;
  closePanel(): void;
  startSelection(): void;
  toggleSelected(bookId: string): void;
  selectBooks(bookIds: readonly string[]): void;
  clearSelection(): void;
  createShelf(name: string, color?: string): Promise<void>;
  updateShelf(shelf: Shelf, patch: { name?: string; color?: string | null; sortOrder?: number }): Promise<void>;
  deleteShelf(shelf: Shelf): Promise<void>;
  setMembership(shelfId: string, bookId: string, included: boolean): Promise<void>;
  saveBookDetails(book: Novel, patch: BookMetadataPatch, cover: CoverDraftAction): Promise<void>;
  applyBatch(command: BatchLibraryCommand, books: readonly Novel[]): Promise<BatchLibraryReceipt | undefined>;
  exportSelectedMetadata(books: readonly Novel[]): void;
}

export interface UseLibraryManagementControllerInput {
  readonly catalog?: LibraryCatalogRepository;
  readonly assets?: BookAssetRepository;
  refreshNovels(): Promise<unknown>;
  refreshAfterMutation(): Promise<unknown>;
  notify(message: string, tone?: 'info' | 'success' | 'warning' | 'danger'): void;
  confirm(message: string): boolean;
}

export function useLibraryManagementController(
  input: UseLibraryManagementControllerInput,
): LibraryManagementController {
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [memberships, setMemberships] = useState<ShelfMembership[]>([]);
  const [activeShelfId, setActiveShelfIdState] = useState<string>();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedBookIds, setSelectedBookIds] = useState<Set<string>>(() => new Set());
  const [panel, setPanel] = useState<LibraryManagementPanel>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [lastBatchReceipt, setLastBatchReceipt] = useState<BatchLibraryReceipt>();

  const refresh = useCallback(async () => {
    if (!input.catalog) return;
    try {
      const [nextShelves, nextMemberships] = await Promise.all([
        input.catalog.listShelves(),
        input.catalog.listShelfMemberships(),
      ]);
      setShelves(nextShelves);
      setMemberships(nextMemberships);
      setActiveShelfIdState((current) =>
        current && nextShelves.some((shelf) => shelf.id === current) ? current : undefined,
      );
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '책장 정보를 불러오지 못했습니다.');
    }
  }, [input.catalog]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (operation: () => Promise<void>, success?: string) => {
      if (busy) return;
      setBusy(true);
      setError(undefined);
      try {
        await operation();
        if (success) input.notify(success, 'success');
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '서재 작업을 완료하지 못했습니다.';
        setError(message);
        input.notify(message, 'danger');
      } finally {
        setBusy(false);
      }
    },
    [busy, input],
  );

  return useMemo<LibraryManagementController>(
    () => ({
      available: Boolean(input.catalog && input.assets),
      shelves,
      memberships,
      activeShelfId,
      selectionMode,
      selectedBookIds,
      panel,
      busy,
      error,
      lastBatchReceipt,
      refresh,
      setActiveShelf: setActiveShelfIdState,
      openShelves: () => setPanel({ kind: 'shelves' }),
      openMetadata: (book) => setPanel({ kind: 'metadata', book }),
      confirmDiscard: input.confirm,
      closePanel: () => setPanel(undefined),
      startSelection: () => setSelectionMode(true),
      toggleSelected: (bookId) => {
        setSelectedBookIds((current) => {
          const next = new Set(current);
          if (next.has(bookId)) next.delete(bookId);
          else next.add(bookId);
          return next;
        });
      },
      selectBooks: (bookIds) => {
        setSelectionMode(true);
        setSelectedBookIds(new Set(bookIds));
      },
      clearSelection: () => {
        setSelectedBookIds(new Set());
        setSelectionMode(false);
      },
      createShelf: async (name, color) => {
        if (!input.catalog) return;
        await run(async () => {
          await input.catalog!.createShelf({ name, color });
          await refresh();
        }, '책장을 만들었습니다.');
      },
      updateShelf: async (shelf, patch) => {
        if (!input.catalog) return;
        await run(async () => {
          await input.catalog!.updateShelf(shelf.id, patch, shelf.revision);
          await refresh();
        }, '책장을 수정했습니다.');
      },
      deleteShelf: async (shelf) => {
        if (!input.catalog || !input.confirm(`"${shelf.name}" 책장을 삭제할까요?\n\n책은 삭제되지 않습니다.`)) return;
        await run(async () => {
          await input.catalog!.deleteShelf(shelf.id, shelf.revision);
          await refresh();
        }, '책장을 삭제했습니다.');
      },
      setMembership: async (shelfId, bookId, included) => {
        if (!input.catalog) return;
        await run(async () => {
          await input.catalog!.setShelfMembership(shelfId, bookId, included);
          await refresh();
          await input.refreshAfterMutation();
        });
      },
      saveBookDetails: async (book, patch, cover) => {
        if (!input.catalog || !input.assets) return;
        await run(async () => {
          let expectedRevision = book.metadataRevision ?? 0;
          if (cover.kind === 'replace') {
            await input.assets!.saveCover(book.id, { ...cover.input, expectedMetadataRevision: expectedRevision });
            expectedRevision += 1;
          } else if (cover.kind === 'remove' && book.coverAssetId) {
            await input.assets!.removeCover(book.id, expectedRevision);
            expectedRevision += 1;
          }
          if (Object.keys(patch).length > 0) await input.catalog!.patchMetadata(book.id, patch, expectedRevision);
          await input.refreshNovels();
          await input.refreshAfterMutation();
          setPanel(undefined);
        }, '책 정보를 저장했습니다.');
      },
      applyBatch: async (command, books) => {
        if (!input.catalog || selectedBookIds.size === 0 || busy) return undefined;
        let receipt: BatchLibraryReceipt | undefined;
        await run(async () => {
          const selected = books.filter((book) => selectedBookIds.has(book.id));
          receipt = await input.catalog!.applyBatch(
            command,
            selected.map((book) => ({ bookId: book.id, expectedRevision: book.metadataRevision ?? 0 })),
            globalThis.crypto?.randomUUID?.() ?? `batch-${Date.now()}`,
          );
          setLastBatchReceipt(receipt);
          setSelectedBookIds(new Set());
          setSelectionMode(false);
          await Promise.all([input.refreshNovels(), refresh(), input.refreshAfterMutation()]);
          const failed = receipt.results.filter((item) => item.status === 'failed').length;
          input.notify(
            failed
              ? `${receipt.results.length - failed}권 처리, ${failed}권 실패`
              : `${receipt.results.length}권을 처리했습니다.`,
            failed ? 'warning' : 'success',
          );
        });
        return receipt;
      },
      exportSelectedMetadata: (books) => {
        const selected = books.filter((book) => selectedBookIds.has(book.id));
        if (selected.length === 0) return;
        downloadLibraryMetadata(selected);
        input.notify(`${selected.length}권의 책 정보를 내보냈습니다.`, 'success');
      },
    }),
    [
      activeShelfId,
      busy,
      error,
      input,
      lastBatchReceipt,
      memberships,
      panel,
      refresh,
      run,
      selectedBookIds,
      selectionMode,
      shelves,
    ],
  );
}
