import { useEffect, useRef, useState } from 'react';
import type { ExternalItemPage, ExternalSourceListInput } from '../../external-sources/contracts';
import { useNavigationViewState } from '../navigation/navigation-view-state';
import type { DiscoverySession } from './discovery-session';

function cachedPages(session: DiscoverySession, source: string, input: ExternalSourceListInput, depth: number) {
  const pages: ExternalItemPage[] = [];
  const visited = new Set<string | undefined>();
  let cursor: string | undefined;
  for (let i = 0; i < depth && !visited.has(cursor); i++) {
    visited.add(cursor);
    const page = session.peek(source, { ...input, cursor })?.page;
    if (!page) break;
    pages.push(page);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return pages;
}

/** Only page depth survives navigation; result bodies stay in the bounded session cache. */
export function useDiscoveryPages(
  session: DiscoverySession,
  source: string,
  input: ExternalSourceListInput,
  refresh: number,
  enabled: boolean,
  filterSignature?: string,
) {
  const key = session.key(source, input);
  const [depth, setDepth] = useNavigationViewState(`discovery-pages:${key}`, 1);
  const [result, setResult] = useState<{ key: string; pages: ExternalItemPage[] }>(() => ({
    key,
    pages: cachedPages(session, source, input, depth),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const previous = useRef({ refresh, retry });
  const pages = result.key === key ? result.pages : cachedPages(session, source, input, depth);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const force = previous.current.refresh !== refresh || previous.current.retry !== retry;
    previous.current = { refresh, retry };
    setBusy(true);
    setError('');
    void (async () => {
      if (filterSignature) {
        const schema = await session.list(source, { parentRef: input.parentRef, browseMode: 'popular' });
        if (JSON.stringify(schema.browse?.filters ?? []) !== filterSignature)
          throw new Error('소스의 필터가 변경되었습니다. 탐색 편집에서 목록을 다시 설정해 주세요.');
        if (!active) return;
      }
      const loaded: ExternalItemPage[] = [];
      const visited = new Set<string | undefined>();
      let cursor: string | undefined;
      for (let i = 0; i < depth && !visited.has(cursor); i++) {
        visited.add(cursor);
        const page = await session.list(source, { ...input, cursor }, force);
        if (!active) return;
        if (page.browse && input.browseMode && !page.browse.availableModes.includes(input.browseMode))
          throw new Error('이 소스는 해당 목록을 지원하지 않습니다.');
        loaded.push(page);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      setResult({ key, pages: loaded });
    })()
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '목록을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
    // Input is represented by the session key; depth is the user's requested page count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, source, key, depth, refresh, retry, enabled, filterSignature]);
  const seen = new Set<string>();
  const items = pages
    .flatMap((page) => page.items)
    .filter((item) => {
      const id = JSON.stringify(item.key);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  const next = pages.at(-1)?.nextCursor;
  const more = Boolean(next && !pages.slice(0, -1).some((page) => page.nextCursor === next));
  return {
    items,
    browse: pages[0]?.browse,
    busy,
    error,
    hasPage: pages.length > 0,
    more,
    loadMore: () => {
      if (more && !busy) setDepth(pages.length + 1);
    },
    retry: () => setRetry((value) => value + 1),
  };
}
