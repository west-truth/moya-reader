import type { BatchLibraryItemResult } from '../../repositories/library-catalog-repository';
import type { ExternalSourceLocalState, ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';

/** Only changes library membership. Reading positions and release preferences survive trash/restore. */
export async function changeSourceLibraryTrash(
  state: ExternalSourceLocalState,
  id: string,
  action: 'trash' | 'restore' | 'purge',
  beforePurge?: (work: ExternalSourceSubscriptionRecord) => Promise<void>,
): Promise<ExternalSourceSubscriptionRecord | undefined> {
  const current = (await state.listSubscriptions()).find((work) => work.id === id);
  if (!current) return;
  if (action === 'purge') {
    if (!current.deletedAt) throw new Error('휴지통에 있는 작품만 영구 삭제할 수 있습니다.');
    await beforePurge?.(current);
    await state.deleteSubscription(id);
    return;
  }
  const next = { ...current, updatedAt: new Date().toISOString() };
  if (action === 'trash') next.deletedAt = current.deletedAt ?? next.updatedAt;
  else delete next.deletedAt;
  await state.saveSubscription(next);
  return next;
}

export async function batchSourceLibraryTrash(
  state: ExternalSourceLocalState,
  ids: readonly string[],
  action: 'trash' | 'restore',
  onChanged?: (work: ExternalSourceSubscriptionRecord) => void,
): Promise<BatchLibraryItemResult[]> {
  const results: BatchLibraryItemResult[] = [];
  for (const id of new Set(ids)) {
    try {
      const work = await changeSourceLibraryTrash(state, id, action);
      if (work) onChanged?.(work);
      results.push({
        bookId: id,
        status: work ? 'applied' : 'failed',
        ...(!work && { reason: '작품을 찾을 수 없습니다.' }),
      });
    } catch (error) {
      results.push({
        bookId: id,
        status: 'failed',
        reason: error instanceof Error ? error.message : '작품을 변경하지 못했습니다.',
      });
    }
  }
  return results;
}
