import type { Novel, Shelf, ShelfMembership } from '../domain/types';
import type { BookMetadataPatch } from '@noveldesk/text-core/library-metadata';

export interface CatalogMutationReceipt {
  readonly bookId: string;
  readonly metadataRevision: number;
  readonly changedAt: string;
}

export interface TrashPurgeReceipt {
  readonly purged: number;
  readonly bookIds: readonly string[];
}

/** Identifies both the mutable catalog revision and the immutable book incarnation. */
export interface BookMutationExpectation {
  readonly metadataRevision?: number;
  readonly activeContentRevisionId?: string;
}
export type BookLifecycleExpectation = BookMutationExpectation;

export interface ShelfMutationReceipt {
  readonly shelf: Shelf;
  readonly operation: 'created' | 'updated' | 'deleted';
}

export type BatchLibraryCommand =
  | { readonly kind: 'add_to_shelf'; readonly shelfId: string }
  | { readonly kind: 'remove_from_shelf'; readonly shelfId: string }
  | { readonly kind: 'add_tag'; readonly tag: string }
  | { readonly kind: 'remove_tag'; readonly tag: string }
  | { readonly kind: 'set_favorite'; readonly favorite: boolean }
  | { readonly kind: 'move_to_trash' }
  | { readonly kind: 'restore_from_trash' };

export interface BatchLibraryTarget {
  readonly bookId: string;
  readonly expectedRevision?: number;
  readonly expectedContentRevisionId?: string;
}

export interface BatchLibraryItemResult {
  readonly bookId: string;
  readonly status: 'applied' | 'skipped' | 'failed';
  readonly metadataRevision?: number;
  readonly reason?: string;
}

export interface BatchLibraryReceipt {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly command: BatchLibraryCommand;
  readonly results: readonly BatchLibraryItemResult[];
  readonly createdAt: string;
}

export interface LibraryCatalogRepository {
  patchMetadata(
    bookId: string,
    patch: BookMetadataPatch,
    expectation?: BookMutationExpectation,
  ): Promise<CatalogMutationReceipt>;
  listTrash(): Promise<Novel[]>;
  moveToTrash(bookId: string, expectation?: BookLifecycleExpectation): Promise<CatalogMutationReceipt>;
  restore(bookId: string, expectation?: BookLifecycleExpectation): Promise<CatalogMutationReceipt>;
  purge(bookId: string, expectation?: BookLifecycleExpectation): Promise<void>;
  emptyTrash(): Promise<TrashPurgeReceipt>;
  listShelves(): Promise<Shelf[]>;
  listShelfMemberships(): Promise<ShelfMembership[]>;
  createShelf(input: { readonly name: string; readonly color?: string }): Promise<ShelfMutationReceipt>;
  updateShelf(
    shelfId: string,
    patch: { readonly name?: string; readonly color?: string | null; readonly sortOrder?: number },
    expectedRevision?: number,
  ): Promise<ShelfMutationReceipt>;
  deleteShelf(shelfId: string, expectedRevision?: number): Promise<ShelfMutationReceipt>;
  setShelfMembership(shelfId: string, bookId: string, included: boolean): Promise<void>;
  applyBatch(
    command: BatchLibraryCommand,
    targets: readonly BatchLibraryTarget[],
    idempotencyKey: string,
  ): Promise<BatchLibraryReceipt>;
}
