import type { LibraryCatalogRepository } from './library-catalog-repository';
import {
  emptyNovelTrash,
  getTrashedNovels,
  moveNovelToTrash,
  purgeNovel,
  restoreNovelFromTrash,
} from '../storage/library-catalog-store';
import {
  applyLibraryBatch,
  createLibraryShelf,
  deleteLibraryShelf,
  listLibraryShelfMemberships,
  listLibraryShelves,
  patchLibraryBookMetadata,
  setLibraryShelfMembership,
  updateLibraryShelf,
} from '../storage/library-management-store';

export class IndexedDbLibraryCatalogRepository implements LibraryCatalogRepository {
  patchMetadata(...args: Parameters<LibraryCatalogRepository['patchMetadata']>) {
    return patchLibraryBookMetadata(...args);
  }

  listTrash() {
    return getTrashedNovels();
  }

  moveToTrash(bookId: string, expectedRevision?: number) {
    return moveNovelToTrash(bookId, expectedRevision);
  }

  restore(bookId: string, expectedRevision?: number) {
    return restoreNovelFromTrash(bookId, expectedRevision);
  }

  purge(bookId: string, expectedRevision?: number) {
    return purgeNovel(bookId, expectedRevision);
  }

  emptyTrash() {
    return emptyNovelTrash();
  }

  listShelves() {
    return listLibraryShelves();
  }

  listShelfMemberships() {
    return listLibraryShelfMemberships();
  }

  createShelf(...args: Parameters<LibraryCatalogRepository['createShelf']>) {
    return createLibraryShelf(...args);
  }

  updateShelf(...args: Parameters<LibraryCatalogRepository['updateShelf']>) {
    return updateLibraryShelf(...args);
  }

  deleteShelf(...args: Parameters<LibraryCatalogRepository['deleteShelf']>) {
    return deleteLibraryShelf(...args);
  }

  setShelfMembership(...args: Parameters<LibraryCatalogRepository['setShelfMembership']>) {
    return setLibraryShelfMembership(...args);
  }

  applyBatch(...args: Parameters<LibraryCatalogRepository['applyBatch']>) {
    return applyLibraryBatch(...args);
  }
}
