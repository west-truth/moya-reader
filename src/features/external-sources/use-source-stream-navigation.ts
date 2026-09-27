import { filterAndSortReleases } from './source-release-list-model';
import { useEffect, useRef, useState } from 'react';
import { externalItemKeyId } from '../../external-sources/contracts';
import type { ExternalSourceController } from './useExternalSourceController';

/** Fetch through catalog cursors without losing the currently open episode on failure. */
export function useSourceStreamNavigation(controller: ExternalSourceController) {
  const [request, setRequest] = useState<{
    origin: string;
    offset: number;
    seen: Set<string>;
    loading: boolean;
    opening: boolean;
    resolve(): void;
    reject(error: Error): void;
    isCurrent(): boolean;
  }>();
  const pending = useRef(request);
  pending.current = request;
  const item = controller.streaming?.item;
  const identity = item && externalItemKeyId(item.key);
  const items = filterAndSortReleases(
    controller.items.filter((item) => item.release),
    '',
    'all',
    'asc',
  );
  const index = items.findIndex((item) => externalItemKeyId(item.key) === identity);
  const latest = useRef(controller);
  latest.current = controller;
  useEffect(() => () => pending.current?.reject(new Error('회차 이동이 취소됐습니다.')), []);
  useEffect(() => {
    if (!request || request.opening || request.loading) return;
    const fail = (message: string) => {
      request.reject(new Error(message));
      setRequest(undefined);
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
      const operation =
        target.importState === 'imported' || target.importState === 'update_available'
          ? (async () => {
              await latest.current.openImported(target);
              latest.current.closeStream?.();
            })()
          : latest.current.importAndOpen(target);
      void operation.then(request.resolve, request.reject).finally(() => setRequest(undefined));
      return;
    }
    if (!controller.nextCursor) {
      fail('더 이동할 회차가 없습니다.');
      return;
    }
    if (controller.catalogLoading || controller.loading) return;
    if (request.seen.has(controller.nextCursor)) {
      fail(controller.listError?.message ?? '다음 회차 목록을 불러오지 못했습니다. 다시 시도해 주세요.');
      return;
    }
    request.seen.add(controller.nextCursor);
    request.loading = true;
    void controller.loadMore().then(
      () => {
        request.loading = false;
        setRequest((current) => (current === request ? { ...request } : current));
      },
      (error: unknown) => fail(error instanceof Error ? error.message : '회차 목록을 불러오지 못했습니다.'),
    );
  }, [request, identity, index, items, controller]);
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
    previous:
      index >= 0 && (index > 0 || controller.nextCursor)
        ? (isCurrent?: () => boolean) => move(-1, isCurrent)
        : undefined,
    next:
      index >= 0 && (index + 1 < items.length || controller.nextCursor)
        ? (isCurrent?: () => boolean) => move(1, isCurrent)
        : undefined,
  };
}
