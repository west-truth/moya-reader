import { externalItemKeyId, type ExternalItemPage, type ExternalItemSummary } from '../../external-sources/contracts';

/** Generic opaque-cursor traversal. Never publish a partially ordered series. */
export async function completeSeriesCatalog(
  first: ExternalItemPage,
  read: (cursor: string) => Promise<ExternalItemPage>,
  signal: AbortSignal,
): Promise<ExternalItemPage> {
  const items = new Map<string, ExternalItemSummary>();
  const seen = new Set<string>();
  const started = Date.now();
  let page = first;
  for (let count = 0; ; count++) {
    signal.throwIfAborted();
    for (const item of page.items) items.set(externalItemKeyId(item.key), item);
    if (items.size > 50_000) throw new Error('목차가 50,000화를 넘어 전체 목록을 저장하지 못했습니다.');
    if (!page.nextCursor) return { ...first, items: [...items.values()], nextCursor: undefined };
    if (seen.has(page.nextCursor)) throw new Error('목차 페이지가 반복되었습니다. 기존 목록을 유지합니다.');
    if (count >= 999 || Date.now() - started > 5 * 60_000)
      throw new Error('전체 목차 확인 시간이 초과되었습니다. 다시 시도해 주세요.');
    seen.add(page.nextCursor);
    page = await read(page.nextCursor);
  }
}
