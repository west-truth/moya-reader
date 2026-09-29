import type { ShelfMembership } from '../../domain/types';
import type { ExternalSourceLibraryWork } from '../external-sources/useExternalSourceController';
import { externalSelectionId } from '../library/library-batch';

/** Keep streamed shelf assignments visible when a work gains downloaded chapters. */
export function libraryShelfMemberships(
  local: readonly Pick<ShelfMembership, 'bookId' | 'shelfId'>[],
  works: readonly Pick<ExternalSourceLibraryWork, 'id' | 'localBookId' | 'shelfIds' | 'deletedAt'>[],
): readonly Pick<ShelfMembership, 'bookId' | 'shelfId'>[] {
  const pairs = new Map(local.map((item) => [JSON.stringify([item.bookId, item.shelfId]), item]));
  for (const work of works) {
    if (work.deletedAt) continue;
    const bookId = work.localBookId ?? externalSelectionId(work.id);
    for (const shelfId of work.shelfIds ?? [])
      if (!pairs.has(JSON.stringify([bookId, shelfId])))
        pairs.set(JSON.stringify([bookId, shelfId]), { bookId, shelfId });
  }
  return [...pairs.values()];
}
