import { mapServerBook } from '../services/remote/remote-book-snapshot';
import type { RemoteApiClient } from '../services/remote/remote-api-client';
import type { LibraryCatalogRepository } from './library-catalog-repository';
import type { Shelf, ShelfMembership } from '../domain/types';

function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

function shelf(row: Record<string, unknown>): Shelf {
  return {
    id: String(row.id),
    name: String(row.name),
    color: typeof row.color === 'string' ? row.color : undefined,
    sortOrder: Number(row.sort_order ?? row.sortOrder),
    createdAt: iso(row.created_at ?? row.createdAt),
    updatedAt: iso(row.updated_at ?? row.updatedAt),
    revision: Number(row.revision),
  };
}

function membership(row: Record<string, unknown>): ShelfMembership {
  return {
    id: String(row.id),
    shelfId: String(row.shelf_id ?? row.shelfId),
    bookId: String(row.book_id ?? row.bookId),
    createdAt: iso(row.created_at ?? row.createdAt),
  };
}

export class RemoteLibraryCatalogRepository implements LibraryCatalogRepository {
  constructor(private readonly client: RemoteApiClient) {}

  async patchMetadata(
    bookId: string,
    patch: Parameters<LibraryCatalogRepository['patchMetadata']>[1],
    expectedRevision?: number,
  ) {
    const result = await this.client.patchBook(bookId, { ...patch, expectedRevision });
    return { bookId, metadataRevision: result.metadataRevision, changedAt: new Date().toISOString() };
  }

  async listTrash() {
    const response = await this.client.listTrashBooks();
    return response.books.map(mapServerBook);
  }

  async moveToTrash(bookId: string, expectedRevision?: number) {
    const result = await this.client.deleteBook(bookId, undefined, expectedRevision);
    return { bookId, metadataRevision: result.metadataRevision, changedAt: new Date().toISOString() };
  }

  async restore(bookId: string, expectedRevision?: number) {
    const result = await this.client.restoreBook(bookId, expectedRevision);
    return { bookId, metadataRevision: result.metadataRevision, changedAt: new Date().toISOString() };
  }

  purge(bookId: string, expectedRevision?: number) {
    return this.client.purgeBook(bookId, expectedRevision).then(() => undefined);
  }

  async emptyTrash() {
    return (await this.client.emptyTrash()).purged;
  }

  async listShelves() {
    return (await this.client.listShelves()).shelves.map(shelf);
  }

  async listShelfMemberships() {
    return (await this.client.listShelves()).memberships.map(membership);
  }

  async createShelf(input: Parameters<LibraryCatalogRepository['createShelf']>[0]) {
    return { shelf: shelf((await this.client.createShelf(input)).shelf), operation: 'created' as const };
  }

  async updateShelf(
    shelfId: string,
    patch: Parameters<LibraryCatalogRepository['updateShelf']>[1],
    expectedRevision?: number,
  ) {
    return {
      shelf: shelf((await this.client.updateShelf(shelfId, { ...patch, expectedRevision })).shelf),
      operation: 'updated' as const,
    };
  }

  async deleteShelf(shelfId: string, expectedRevision?: number) {
    return {
      shelf: shelf((await this.client.deleteShelf(shelfId, expectedRevision)).shelf),
      operation: 'deleted' as const,
    };
  }

  setShelfMembership(shelfId: string, bookId: string, included: boolean) {
    return this.client.setShelfMembership(shelfId, bookId, included).then(() => undefined);
  }

  applyBatch(...args: Parameters<LibraryCatalogRepository['applyBatch']>) {
    return this.client.applyLibraryBatch(...args).then((result) => result.receipt);
  }
}
