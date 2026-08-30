import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

export class LibraryMetadataEditConflictError extends Error {
  constructor() {
    super(
      '같은 항목이 다른 기기나 자동 적용으로 변경되어 저장하지 않았습니다. 현재 입력은 보존했습니다. 현재 입력을 우선하려면 저장을 한 번 더 누르세요.',
    );
    this.name = 'LibraryMetadataEditConflictError';
  }
}

function comparableMetadataValue(book: Novel, field: keyof BookMetadataPatch): unknown {
  if (field === 'tags') return [...(book.tags ?? [])];
  if (field === 'coverFit') return book.coverFit ?? 'crop';
  if (field === 'coverPositionX') return book.coverPositionX ?? 50;
  if (field === 'coverPositionY') return book.coverPositionY ?? 50;
  if (field === 'favorite') return book.favorite ?? false;
  return book[field] ?? null;
}

function sameMetadataValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function metadataEditCanRebase(base: Novel, current: Novel, patch: BookMetadataPatch): boolean {
  return (Object.keys(patch) as Array<keyof BookMetadataPatch>).every((field) =>
    sameMetadataValue(comparableMetadataValue(base, field), comparableMetadataValue(current, field)),
  );
}

function coverIdentityChanged(base: Novel, current: Novel): boolean {
  return (
    base.coverAssetId !== current.coverAssetId ||
    base.coverContentHash !== current.coverContentHash ||
    (base.coverFit ?? 'crop') !== (current.coverFit ?? 'crop') ||
    (base.coverPositionX ?? 50) !== (current.coverPositionX ?? 50) ||
    (base.coverPositionY ?? 50) !== (current.coverPositionY ?? 50)
  );
}

function metadataRevision(book: Novel): number {
  return book.metadataRevision ?? 0;
}

function newerMetadataSnapshot(left: Novel, right: Novel): Novel {
  return metadataRevision(right) >= metadataRevision(left) ? right : left;
}

function metadataPatchAlreadyApplied(book: Novel, patch: BookMetadataPatch): boolean {
  return (Object.keys(patch) as Array<keyof BookMetadataPatch>).every((field) =>
    sameMetadataValue(comparableMetadataValue(book, field), patch[field] ?? null),
  );
}

function applyMetadataPatchSnapshot(
  book: Novel,
  patch: BookMetadataPatch,
  metadataRevision: number,
  changedAt: string,
): Novel {
  const next: Novel = { ...book, metadataRevision, updatedAt: changedAt };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.author !== undefined) next.author = patch.author ?? undefined;
  if (patch.seriesTitle !== undefined) next.seriesTitle = patch.seriesTitle ?? undefined;
  if (patch.seriesIndex !== undefined) next.seriesIndex = patch.seriesIndex ?? undefined;
  if (patch.tags !== undefined) next.tags = [...patch.tags];
  if (patch.description !== undefined) next.description = patch.description ?? undefined;
  if (patch.language !== undefined) next.language = patch.language ?? undefined;
  if (patch.favorite !== undefined) next.favorite = patch.favorite;
  if (patch.coverFit !== undefined) next.coverFit = patch.coverFit;
  if (patch.coverPositionX !== undefined) next.coverPositionX = patch.coverPositionX;
  if (patch.coverPositionY !== undefined) next.coverPositionY = patch.coverPositionY;
  return next;
}

function metadataRevisionConflict(cause: unknown): boolean {
  return cause instanceof Error && /metadata revision changed|metadata_revision_changed/iu.test(cause.message);
}

function libraryManagementError(cause: unknown): string {
  if (cause instanceof LibraryMetadataEditConflictError) return cause.message;
  if (cause instanceof Error && /metadata revision changed|metadata_revision_changed/iu.test(cause.message)) {
    return '다른 변경이 먼저 저장되었습니다. 최신 작품 정보를 불러온 뒤 다시 시도해 주세요.';
  }
  return cause instanceof Error ? cause.message : '서재 작업을 완료하지 못했습니다.';
}

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
  refreshOpenMetadata(): Promise<void>;
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
  getNovel(bookId: string): Promise<Novel | undefined>;
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
  const busyRef = useRef(false);
  const latestBooksRef = useRef(new Map<string, Novel>());

  const rememberBook = useCallback((book: Novel): Novel => {
    const remembered = latestBooksRef.current.get(book.id);
    const latest = remembered ? newerMetadataSnapshot(remembered, book) : book;
    latestBooksRef.current.set(book.id, latest);
    return latest;
  }, []);

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
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(undefined);
      try {
        await operation();
        if (success) input.notify(success, 'success');
      } catch (cause) {
        const message = libraryManagementError(cause);
        setError(message);
        input.notify(message, 'danger');
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [input],
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
      openMetadata: (book) => setPanel({ kind: 'metadata', book: rememberBook(book) }),
      confirmDiscard: input.confirm,
      closePanel: () => setPanel(undefined),
      refreshOpenMetadata: async () => {
        if (panel?.kind !== 'metadata') return;
        try {
          const fresh = await input.getNovel(panel.book.id);
          if (!fresh) return;
          const latest = rememberBook(fresh);
          setPanel((current) =>
            current?.kind === 'metadata' && current.book.id === latest.id
              ? { kind: 'metadata', book: latest }
              : current,
          );
        } catch {
          const message = '적용된 작품 정보를 화면에 다시 불러오지 못했습니다. 편집창을 다시 열어 주세요.';
          setError(message);
          input.notify(message, 'warning');
        }
      },
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
          if (Object.keys(patch).length === 0 && cover.kind === 'keep') {
            setPanel(undefined);
            return;
          }
          const loaded = await input.getNovel(book.id);
          if (!loaded) throw new Error('작품을 다시 불러오지 못했습니다.');
          let current = rememberBook(loaded);
          const coverWasEdited =
            cover.kind !== 'keep' ||
            patch.coverFit !== undefined ||
            patch.coverPositionX !== undefined ||
            patch.coverPositionY !== undefined;
          if (!metadataEditCanRebase(book, current, patch) || (coverWasEdited && coverIdentityChanged(book, current))) {
            setPanel({ kind: 'metadata', book: current });
            throw new LibraryMetadataEditConflictError();
          }
          let expectedRevision = current.metadataRevision ?? 0;
          if (cover.kind === 'replace') {
            let savedCover;
            try {
              savedCover = await input.assets!.saveCover(book.id, {
                ...cover.input,
                expectedMetadataRevision: expectedRevision,
                expectedContentRevisionId: current.activeContentRevisionId,
              });
            } catch (cause) {
              if (!metadataRevisionConflict(cause)) throw cause;
              const fresh = await input.getNovel(book.id);
              if (!fresh || coverIdentityChanged(current, fresh) || !metadataEditCanRebase(current, fresh, patch)) {
                if (fresh) {
                  current = rememberBook(fresh);
                  setPanel({ kind: 'metadata', book: current });
                }
                throw new LibraryMetadataEditConflictError();
              }
              current = rememberBook(fresh);
              expectedRevision = metadataRevision(current);
              savedCover = await input.assets!.saveCover(book.id, {
                ...cover.input,
                expectedMetadataRevision: expectedRevision,
                expectedContentRevisionId: current.activeContentRevisionId,
              });
            }
            expectedRevision += 1;
            current = rememberBook({
              ...current,
              coverAssetId: savedCover.id,
              coverContentHash: savedCover.contentHash,
              coverFit: cover.input.fit,
              coverPositionX: cover.input.positionX,
              coverPositionY: cover.input.positionY,
              coverRemovedAt: undefined,
              metadataRevision: expectedRevision,
              updatedAt: savedCover.createdAt,
            });
          } else if (cover.kind === 'remove' && current.coverAssetId) {
            try {
              await input.assets!.removeCover(book.id, {
                metadataRevision: expectedRevision,
                activeContentRevisionId: current.activeContentRevisionId,
              });
            } catch (cause) {
              if (!metadataRevisionConflict(cause)) throw cause;
              const fresh = await input.getNovel(book.id);
              if (!fresh || coverIdentityChanged(current, fresh) || !metadataEditCanRebase(current, fresh, patch)) {
                if (fresh) {
                  current = rememberBook(fresh);
                  setPanel({ kind: 'metadata', book: current });
                }
                throw new LibraryMetadataEditConflictError();
              }
              current = rememberBook(fresh);
              expectedRevision = metadataRevision(current);
              await input.assets!.removeCover(book.id, {
                metadataRevision: expectedRevision,
                activeContentRevisionId: current.activeContentRevisionId,
              });
            }
            expectedRevision += 1;
            const removedAt = new Date().toISOString();
            current = rememberBook({
              ...current,
              coverAssetId: undefined,
              coverContentHash: undefined,
              coverRemovedAt: removedAt,
              metadataRevision: expectedRevision,
              updatedAt: removedAt,
            });
          }
          if (Object.keys(patch).length > 0) {
            try {
              const receipt = await input.catalog!.patchMetadata(book.id, patch, {
                metadataRevision: expectedRevision,
                activeContentRevisionId: current.activeContentRevisionId,
              });
              current = rememberBook(
                applyMetadataPatchSnapshot(current, patch, receipt.metadataRevision, receipt.changedAt),
              );
            } catch (cause) {
              if (!metadataRevisionConflict(cause)) throw cause;
              const fresh = await input.getNovel(book.id);
              if (!fresh) throw cause;
              if (metadataPatchAlreadyApplied(fresh, patch)) {
                rememberBook(fresh);
              } else if (metadataEditCanRebase(current, fresh, patch)) {
                current = rememberBook(fresh);
                const receipt = await input.catalog!.patchMetadata(book.id, patch, {
                  metadataRevision: metadataRevision(current),
                  activeContentRevisionId: current.activeContentRevisionId,
                });
                rememberBook(applyMetadataPatchSnapshot(current, patch, receipt.metadataRevision, receipt.changedAt));
              } else {
                current = rememberBook(fresh);
                setPanel({ kind: 'metadata', book: current });
                throw new LibraryMetadataEditConflictError();
              }
            }
          }
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
            selected.map((book) => ({
              bookId: book.id,
              expectedRevision: book.metadataRevision ?? 0,
              expectedContentRevisionId: book.activeContentRevisionId,
            })),
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
      rememberBook,
      refresh,
      run,
      selectedBookIds,
      selectionMode,
      shelves,
    ],
  );
}
