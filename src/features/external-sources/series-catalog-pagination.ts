import { externalItemKeyId, type ExternalItemPage, type ExternalItemSummary } from '../../external-sources/contracts';
import type { ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';

export const MAX_SUBSCRIPTION_CHECK_PAGES = 20;
export const MAX_SUBSCRIPTION_CHECK_RELEASES = 1_000;
export const MAX_SUBSCRIPTION_CHECK_TOTAL_PAGES = 50;

/** A partial page never proves that unseen historical releases are new or absent. */
export function reconcileSubscriptionReleaseIds(
  current: ExternalSourceSubscriptionRecord,
  releaseIds: readonly string[],
  complete: boolean,
): Pick<
  ExternalSourceSubscriptionRecord,
  'knownReleaseIds' | 'newReleaseIds' | 'availableReleaseCount' | 'releaseBaselineComplete'
> {
  const observed = new Set(releaseIds);
  const known = new Set(current.knownReleaseIds);
  const newlySeen = current.releaseBaselineComplete ? [...observed].filter((id) => !known.has(id)) : [];
  const nextNew = [...new Set([...current.newReleaseIds, ...newlySeen])];
  const nextKnown = [...new Set([...known, ...observed])];
  return {
    knownReleaseIds: nextKnown,
    newReleaseIds: complete ? nextNew.filter((id) => observed.has(id)) : nextNew,
    availableReleaseCount: complete ? observed.size : Math.max(current.availableReleaseCount, nextKnown.length),
    releaseBaselineComplete: current.releaseBaselineComplete === true || complete,
  };
}

/** Metadata only. A limit or cursor cycle returns an explicitly incomplete snapshot. */
export async function collectSubscriptionReleasePages(input: {
  readPage(cursor: string | undefined, signal: AbortSignal): Promise<ExternalItemPage>;
  signal: AbortSignal;
  takePageBudget?(): boolean;
}): Promise<ExternalItemPage & { readonly complete: boolean }> {
  const items = new Map<string, ExternalItemSummary>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let detail: ExternalItemPage['detail'];
  for (let pageIndex = 0; pageIndex < MAX_SUBSCRIPTION_CHECK_PAGES; pageIndex += 1) {
    input.signal.throwIfAborted();
    if (input.takePageBudget && !input.takePageBudget()) {
      return { detail, items: [...items.values()], complete: false };
    }
    const page = await input.readPage(cursor, input.signal);
    input.signal.throwIfAborted();
    detail ??= page.detail;
    for (const item of page.items) {
      if (!item.release) continue;
      const key = externalItemKeyId(item.key);
      if (!items.has(key) && items.size >= MAX_SUBSCRIPTION_CHECK_RELEASES) {
        return { detail, items: [...items.values()], complete: false };
      }
      items.set(key, item);
    }
    if (!page.nextCursor) return { detail, items: [...items.values()], complete: true };
    if (items.size >= MAX_SUBSCRIPTION_CHECK_RELEASES || cursors.has(page.nextCursor)) {
      return { detail, items: [...items.values()], complete: false };
    }
    cursor = page.nextCursor;
    cursors.add(cursor);
  }
  return { detail, items: [...items.values()], complete: false };
}

/** Preserve provider page order, then append local-only releases in their saved order. */
export function mergeSeriesCatalogItems(
  localItems: readonly ExternalItemSummary[],
  remoteItems: readonly ExternalItemSummary[],
): readonly ExternalItemSummary[] {
  const merged = new Map(remoteItems.map((item) => [externalItemKeyId(item.key), item]));
  localItems.forEach((item) => {
    const key = externalItemKeyId(item.key);
    if (!merged.has(key)) merged.set(key, item);
  });
  return [...merged.values()];
}
