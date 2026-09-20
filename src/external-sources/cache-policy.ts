import type { ExternalItemPage, ExternalSourceListInput } from './contracts';
const minute = 60_000,
  hour = 60 * minute,
  day = 24 * hour;
export const COVER_FRESH_MS = day;
export const COVER_KEEP_MS = 7 * day;
export const DETAIL_FRESH_MS = 6 * hour;
export function sourceCachePolicy(input: ExternalSourceListInput, completed = false) {
  if (input.parentRef) return { fresh: completed ? 6 * hour : 2 * minute, keep: 7 * day };
  if (input.query || input.filters?.length || input.browseMode === 'search')
    return { fresh: 10 * minute, keep: 6 * hour };
  return { fresh: input.browseMode === 'latest' ? 2 * minute : 30 * minute, keep: day };
}
export function sourcePageTime(page: ExternalItemPage, fallback = Date.now()) {
  const time = page.cache?.fetchedAt;
  return typeof time === 'number' && Number.isFinite(time) && time > 0 ? Math.min(time, fallback) : fallback;
}
export function transientSourceFailure(error: unknown) {
  let value = error as
    { status?: number; statusCode?: number; code?: string; message?: string; cause?: unknown } | undefined;
  let transient = false;
  for (let depth = 0; value && depth < 3; depth++) {
    const status = value.status ?? value.statusCode ?? 0;
    const message = `${value.code ?? ''} ${value.message ?? ''}`;
    if (
      [401, 403, 404, 410].includes(status) ||
      /access_denied|auth_|generation_changed|catalog_changed|work_unavailable|HTTP (?:401|403|404|410)/i.test(message)
    )
      return false;
    transient ||=
      [429, 500, 502, 503, 504].includes(status) ||
      /timeout|timed out|network|offline|fetch failed|failed to fetch|connection_failed|ECONN|ENET|EAI_AGAIN|execution_busy|worker_busy|HTTP (?:429|50[0234])|gateway|연결.*실패|시간.*초과/i.test(
        message,
      );
    value = value.cause as typeof value;
  }
  return transient;
}
/** Hosts keep cache mode out of the extension guest's input and out of cache identity. */
export function sourceListIdentity(input: ExternalSourceListInput) {
  const { cacheMode: _mode, ...identity } = input;
  return identity;
}
