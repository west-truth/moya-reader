import { filterAndSortReleases } from './source-release-list-model';
import { useEffect, useRef, useState } from 'react';
import { externalItemKeyId } from '../../external-sources/contracts';
import type { ExternalSourceController } from './useExternalSourceController';

/** Fetch through catalog cursors without losing the currently open episode on failure. */
export function useSourceStreamNavigation(controller: ExternalSourceController, prefetchEnabled = false) {
  const [request, setRequest] = useState<{
    origin: string;
    offset: number;
    seen: Set<string>;
    loading: boolean;
    opening: boolean;
    catalogRetried?: boolean;
    resolve(): void;
    reject(error: Error): void;
    isCurrent(): boolean;
  }>();
  const pending = useRef(request);
  pending.current = request;
  const item = controller.streaming?.item;
  const identity = item && externalItemKeyId(item.key);
  const catalog = controller.streamCatalog;
  const catalogLoading = catalog ? catalog.loading : controller.catalogLoading || controller.loading;
  const catalogCursor = catalog ? undefined : controller.nextCursor;
  const known = new Map(controller.items.map((candidate) => [externalItemKeyId(candidate.key), candidate]));
  const navigationItems = catalog
    ? (catalog.items ?? []).map((candidate) => ({
        ...candidate,
        selected: false,
        importState:
          candidate.importability === 'unsupported'
            ? ('unsupported' as const)
            : (known.get(externalItemKeyId(candidate.key))?.importState ?? ('available' as const)),
        localOrderOnly: false,
      }))
    : controller.items;
  const items = filterAndSortReleases(
    navigationItems.filter(
      (candidate) =>
        candidate.release &&
        !candidate.localOrderOnly &&
        candidate.key.connectorId === item?.key.connectorId &&
        candidate.key.accountConnectionId === item?.key.accountConnectionId &&
        candidate.collection?.remoteId === item?.collection?.remoteId,
    ),
    '',
    'all',
    'asc',
  );
  const index = items.findIndex((item) => externalItemKeyId(item.key) === identity);
  const [warmRevision, setWarmRevision] = useState(0);
  const warming = useRef({ identity, cursors: new Set<string>(), busy: false });
  useEffect(() => {
    if (warming.current.identity !== identity) warming.current = { identity, cursors: new Set(), busy: false };
    const state = warming.current;
    const cursor = catalogCursor;
    if (
      !prefetchEnabled ||
      !identity ||
      index < 0 ||
      items[index + 1] ||
      !cursor ||
      request ||
      catalogLoading ||
      state.busy ||
      state.cursors.has(cursor) ||
      state.cursors.size >= 32
    )
      return;
    state.busy = true;
    state.cursors.add(cursor);
    void controller
      .loadMore()
      .catch(() => undefined)
      .finally(() => {
        state.busy = false;
        setWarmRevision((value) => value + 1);
      });
  }, [prefetchEnabled, identity, index, items, controller, request, warmRevision, catalogCursor, catalogLoading]);
  const latest = useRef(controller);
  latest.current = controller;
  useEffect(() => () => pending.current?.reject(new Error('회차 이동이 취소됐습니다.')), []);
  useEffect(() => {
    if (!request || request.opening || request.loading) return;
    const fail = (message: string) => {
      request.reject(new Error(message));
      setRequest((current) => (current === request ? undefined : current));
    };
    if (identity !== request.origin || !request.isCurrent()) {
      fail('회차 이동이 취소됐습니다.');
      return;
    }
    const target = items[index + request.offset];
    if (index >= 0 && target) {
      if (target.importState === 'unsupported') {
        fail('지원하지 않는 회차 형식입니다. 회차 목록에서 확인해 주세요.');
        return;
      }
      request.opening = true;
      const operation = latest.current.openStreamItem
        ? latest.current.openStreamItem(target)
        : target.importState === 'imported' || target.importState === 'update_available'
          ? (async () => {
              await latest.current.openImported(target, true);
              latest.current.closeStream?.();
            })()
          : latest.current.importAndOpen(target);
      void operation
        .then(request.resolve, request.reject)
        .finally(() => setRequest((current) => (current === request ? undefined : current)));
      return;
    }
    if (catalog?.error) {
      if (request.catalogRetried) {
        fail(catalog.error);
        return;
      }
      request.catalogRetried = true;
      request.loading = true;
      void catalog.retry().then(
        () => {
          request.loading = false;
          setRequest((current) => (current === request ? { ...request } : current));
        },
        (error: unknown) => fail(error instanceof Error ? error.message : '목차를 확인하지 못했습니다.'),
      );
      return;
    }
    if (catalogLoading) return;
    if (!catalogCursor) {
      fail('더 이동할 회차가 없습니다.');
      return;
    }
    if (request.seen.has(catalogCursor)) {
      fail(controller.listError?.message ?? '다음 회차 목록을 불러오지 못했습니다. 다시 시도해 주세요.');
      return;
    }
    request.seen.add(catalogCursor);
    request.loading = true;
    void controller.loadMore().then(
      () => {
        request.loading = false;
        setRequest((current) => (current === request ? { ...request } : current));
      },
      (error: unknown) => fail(error instanceof Error ? error.message : '회차 목록을 불러오지 못했습니다.'),
    );
  }, [request, identity, index, items, controller, catalog, catalogLoading, catalogCursor]);
  const move = (offset: number, isCurrent = () => true) =>
    new Promise<void>((resolve, reject) => {
      if (!identity || pending.current) {
        reject(new Error('회차 이동 중입니다.'));
        return;
      }
      const value = {
        origin: identity,
        offset,
        seen: new Set<string>(),
        loading: false,
        opening: false,
        resolve,
        reject,
        isCurrent,
      };
      pending.current = value;
      setRequest(value);
    });
  return {
    busy: Boolean(request),
    nextItem: index >= 0 ? items[index + 1] : undefined,
    previous:
      identity && (index > 0 || catalogCursor || catalogLoading || catalog?.error)
        ? (isCurrent?: () => boolean) => move(-1, isCurrent)
        : undefined,
    next:
      identity && ((index >= 0 && index + 1 < items.length) || catalogCursor || catalogLoading || catalog?.error)
        ? (isCurrent?: () => boolean) => move(1, isCurrent)
        : undefined,
  };
}
