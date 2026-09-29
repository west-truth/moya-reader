import type { Novel } from '../../domain/types';
import type { LibraryCatalogRepository } from '../../repositories/library-catalog-repository';

export async function renameLibraryBook(
  catalog: LibraryCatalogRepository,
  getNovel: (id: string) => Promise<Novel | undefined>,
  book: Novel,
  value: string,
): Promise<void> {
  const title = value.trim();
  if (!title || title.length > 300) throw new Error('제목을 1~300자로 입력해 주세요.');
  const current = await getNovel(book.id);
  if (!current || current.deletedAt) throw new Error('서재에서 작품을 찾을 수 없습니다.');
  if (current.title === title) return;
  if (current.title !== book.title) throw new Error('다른 곳에서 제목을 변경했습니다. 창을 닫고 다시 열어 주세요.');
  await catalog.patchMetadata(book.id, { title }, current.metadataRevision ?? 0);
}

export async function moveLibraryBookToShelf(catalog: LibraryCatalogRepository, bookId: string, shelfId?: string) {
  const shelves = await catalog.listShelves();
  if (shelfId && !shelves.some((shelf) => shelf.id === shelfId))
    throw new Error('선택한 책장이 삭제되었습니다. 다른 책장을 선택해 주세요.');
  const current = await catalog.listShelfMemberships();
  // Add first: a failed removal leaves both memberships, so the user can safely retry.
  if (shelfId) await catalog.setShelfMembership(shelfId, bookId, true);
  for (const item of current)
    if (item.bookId === bookId && item.shelfId !== shelfId)
      await catalog.setShelfMembership(item.shelfId, bookId, false);
}
