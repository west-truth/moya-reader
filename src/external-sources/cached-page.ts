import type { ExternalCatalogCachePage, ExternalItemPage, ExternalSourceListInput } from './contracts';
import { sourceCachePolicy, sourcePageTime } from './cache-policy';

// Object URLs belong to the current document. Keep direct URLs for sources without a cover resolver.
function persistentCover(item: { thumbnailUrl?: string; coverRef?: unknown }) {
  return item.coverRef ||
    item.thumbnailUrl?.startsWith('blob:') ||
    /[?&](?:x-amz-signature|signature|token|access_token|expires|sig|se)=/i.test(item.thumbnailUrl ?? '')
    ? undefined
    : item.thumbnailUrl;
}
export function storedSourcePage(
  id: string,
  source: string,
  input: ExternalSourceListInput,
  page: ExternalItemPage,
  scope?: string,
): ExternalCatalogCachePage {
  const time = sourcePageTime(page),
    policy = sourceCachePolicy(input);
  const needsCoverRefresh = [...page.items, ...(page.detail ? [page.detail] : [])].some(
    (item) => item.thumbnailUrl && !item.coverRef && !persistentCover(item),
  );
  return {
    id,
    scope,
    connectorId: source,
    accountConnectionId: input.accountConnectionId,
    queryFingerprint: JSON.stringify(input),
    cursor: input.cursor,
    nextCursor: page.nextCursor,
    items: page.items.map((item) => ({ ...item, thumbnailUrl: persistentCover(item) })),
    detail: page.detail ? { ...page.detail, thumbnailUrl: persistentCover(page.detail) } : undefined,
    browse: page.browse,
    fetchedAt: new Date(time).toISOString(),
    expiresAt: new Date(time + (needsCoverRefresh ? 0 : policy.fresh)).toISOString(),
    retainUntil: new Date(time + policy.keep).toISOString(),
    schemaVersion: 1,
  };
}
export function restoredSourcePage(page: ExternalCatalogCachePage): ExternalItemPage {
  return {
    items: page.items,
    detail: page.detail,
    browse: page.browse,
    nextCursor: page.nextCursor,
    cache: { fetchedAt: Date.parse(page.fetchedAt), stale: Date.parse(page.expiresAt) <= Date.now() },
  };
}
export async function saveSourceCache(
  store: { saveCachePage(page: ExternalCatalogCachePage): Promise<void> },
  page: ExternalCatalogCachePage,
) {
  try {
    await store.saveCachePage(page);
  } catch {
    /* A full/disabled cache must not turn a successful request into an error. */
  }
}
