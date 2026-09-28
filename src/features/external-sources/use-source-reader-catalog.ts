import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { ExternalCatalogCachePage, ExternalItemSummary } from '../../external-sources/contracts';
import type { UseExternalSourceControllerOptions } from './useExternalSourceController';
import { completeSeriesCatalog } from './complete-series-catalog';
import { cachePageId, saveSourceCache, storedSourcePage } from '../../external-sources/cached-page';
import { sourceCachePolicy, transientSourceFailure } from '../../external-sources/cache-policy';

export interface SourceReaderCatalog {
  readonly items?: readonly ExternalItemSummary[];
  readonly loading: boolean;
  readonly error?: string;
  retry(): Promise<void>;
}

/** Reuse the detail/resume cache; fill a missing complete catalog without blocking the current episode. */
export function useSourceReaderCatalog(
  item: ExternalItemSummary | undefined,
  options: UseExternalSourceControllerOptions,
  detailLoading = false,
): SourceReaderCatalog | undefined {
  const latest = useRef(options);
  latest.current = options;
  const currentItem = useRef(item);
  currentItem.current = item;
  const connection =
    item &&
    options.registry.getExternalSourceStatus(item.key.connectorId as ExtensionContributionId, options.hostContext);
  const key = item?.collection
    ? JSON.stringify([
        options.settingsScope,
        item.key.connectorId,
        item.key.accountConnectionId,
        item.collection.remoteId,
        connection?.state,
        connection?.accountConnectionId,
        connection?.connectionGeneration,
      ])
    : undefined;
  const [snapshot, setSnapshot] = useState<{
    key: string;
    items?: readonly ExternalItemSummary[];
    loading: boolean;
    error?: string;
  }>();
  const active = useRef<AbortController>();
  const run = useCallback(async () => {
    if (!key) return;
    active.current?.abort();
    const abort = new AbortController();
    active.current = abort;
    const [, sourceId, account, parentRef, state, connectedAccount, generation] = JSON.parse(key) as (string | null)[];
    setSnapshot({ key, loading: true });
    const current = latest.current;
    const input = { parentRef: parentRef!, accountConnectionId: account ?? undefined };
    const id = cachePageId(sourceId!, account ?? undefined, input, current.settingsScope, generation ?? undefined);
    const assertConnection = () => {
      const currentConnection = current.registry.getExternalSourceStatus(
        sourceId as ExtensionContributionId,
        current.hostContext,
      );
      if (
        currentConnection.state !== 'connected' ||
        (currentConnection.accountConnectionId ?? null) !== account ||
        (currentConnection.connectionGeneration ?? null) !== generation
      )
        throw new Error('소스 연결이 변경되었습니다. 다음 화를 누르면 목차를 다시 확인합니다.');
    };
    let cached: ExternalCatalogCachePage | undefined;
    const timer = setTimeout(
      () => abort.abort(new Error('목차 확인 시간이 초과되었습니다. 다음 화를 누르면 다시 시도합니다.')),
      30000,
    );
    let onAbort: (() => void) | undefined;
    try {
      if (state !== 'connected' || connectedAccount !== account)
        throw new Error('목차를 확인하려면 해당 소스 계정으로 다시 연결해 주세요.');
      cached = await current.state.getCachePage(id).catch(() => undefined);
      abort.signal.throwIfAborted();
      assertConnection();
      const policy = sourceCachePolicy(input);
      if (!cached?.completeSeries || cached.nextCursor || Date.parse(cached.fetchedAt) + policy.keep <= Date.now())
        cached = undefined;
      if (cached) {
        setSnapshot({ key, items: cached.items, loading: true });
        if (
          Date.parse(cached.expiresAt) > Date.now() &&
          Date.parse(cached.fetchedAt) + policy.fresh > Date.now() &&
          cached.items.some((entry) => entry.key.remoteId === currentItem.current?.key.remoteId)
        ) {
          setSnapshot({ key, items: cached.items, loading: false });
          return;
        }
      }
      const read = (cursor?: string) =>
        current.registry.listExternalSource(
          sourceId as ExtensionContributionId,
          current.hostContext,
          {
            ...input,
            cursor,
            cacheMode: cursor || !cached ? undefined : 'reload',
          },
          abort.signal,
        );
      const operation = (async () => completeSeriesCatalog(await read(), read, abort.signal))();
      const page = await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(abort.signal.reason);
          abort.signal.addEventListener('abort', onAbort, { once: true });
          if (abort.signal.aborted) onAbort();
        }),
      ]);
      abort.signal.throwIfAborted();
      assertConnection();
      if (active.current !== abort) return;
      const items = page.items.filter(
        (candidate) =>
          candidate.release &&
          candidate.key.connectorId === sourceId &&
          (candidate.key.accountConnectionId ?? null) === account &&
          candidate.collection?.remoteId === parentRef,
      );
      setSnapshot({ key, items, loading: false });
      await saveSourceCache(current.state, {
        ...storedSourcePage(id, sourceId!, input, page, current.settingsScope),
        completeSeries: true,
      });
    } catch (error) {
      if (active.current !== abort) return;
      setSnapshot({
        key,
        loading: false,
        items: transientSourceFailure(error) ? cached?.items : undefined,
        error: error instanceof Error ? error.message : '목차를 확인하지 못했습니다. 다음 화를 누르면 다시 시도합니다.',
      });
      throw error;
    } finally {
      clearTimeout(timer);
      if (onAbort) abort.signal.removeEventListener('abort', onAbort);
    }
  }, [key]);
  useEffect(() => {
    if (detailLoading) return;
    void run().catch(() => undefined);
    return () => {
      const previous = active.current;
      active.current = undefined;
      previous?.abort();
    };
  }, [run, detailLoading]);
  if (!key) return undefined;
  return {
    ...(snapshot?.key === key ? snapshot : { loading: true }),
    ...(detailLoading ? { loading: true, error: undefined } : {}),
    retry: run,
  };
}
