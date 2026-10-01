import type { ExternalSourceLocalState, ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';

export interface SourceLibraryMetadataPatch {
  readonly title?: string;
  readonly shelfIds?: readonly string[];
  readonly shelfMembership?: { readonly shelfId: string; readonly included: boolean };
}

/** Change membership metadata without requiring the content source to be connected. */
export async function updateSourceLibraryMetadata(
  state: Pick<ExternalSourceLocalState, 'listSubscriptions' | 'saveSubscription'>,
  id: string,
  patch: SourceLibraryMetadataPatch,
): Promise<ExternalSourceSubscriptionRecord> {
  const current = (await state.listSubscriptions()).find((work) => work.id === id);
  if (!current || current.deletedAt) throw new Error('서재에서 작품을 찾을 수 없습니다.');
  const title = patch.title?.trim();
  if (patch.title !== undefined && (!title || title.length > 1024))
    throw new Error('제목을 1~1,024자로 입력해 주세요.');
  const shelves = new Set(patch.shelfIds ?? current.shelfIds ?? []);
  if (patch.shelfMembership) {
    if (patch.shelfMembership.included) shelves.add(patch.shelfMembership.shelfId);
    else shelves.delete(patch.shelfMembership.shelfId);
  }
  const next = {
    ...current,
    ...(title ? { title, titleOverride: title } : {}),
    ...(patch.shelfIds || patch.shelfMembership ? { shelfIds: [...shelves] } : {}),
    updatedAt: new Date().toISOString(),
  };
  await state.saveSubscription(next);
  return next;
}
