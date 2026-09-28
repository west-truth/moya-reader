import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';

export type LibraryCoverWork = Pick<
  ExternalSourceSubscriptionRecord,
  'id' | 'connectorId' | 'accountConnectionId' | 'navigationRef'
>;

/** Device URLs are deliberately absent from synced subscriptions; resolve them on this device. */
export function useLibraryWorkCovers<T extends ExternalSourceSubscriptionRecord>(
  works: readonly T[],
  connectionKey: string,
  resolve: (work: LibraryCoverWork, signal: AbortSignal) => Promise<string | undefined>,
): readonly T[] {
  const [covers, setCovers] = useState<ReadonlyMap<string, string>>(() => new Map());
  const resolved = useRef(new Map<string, string>());
  const targets = JSON.stringify(
    works
      .filter((work) => !work.thumbnailUrl)
      .map(({ id, connectorId, accountConnectionId, navigationRef }) => ({
        id,
        connectorId,
        accountConnectionId,
        navigationRef,
      })),
  );
  useEffect(() => {
    const pending = JSON.parse(targets) as LibraryCoverWork[];
    const abort = new AbortController();
    let next = 0;
    const run = async () => {
      while (next < pending.length && !abort.signal.aborted) {
        const work = pending[next++]!;
        const key = `${connectionKey}:${work.id}`;
        if (resolved.current.has(key)) continue;
        const request = new AbortController();
        const cancel = () => request.abort();
        abort.signal.addEventListener('abort', cancel, { once: true });
        const timeout = setTimeout(cancel, 10_000);
        try {
          const url = await resolve(work, request.signal);
          if (url && !request.signal.aborted) {
            resolved.current.set(key, url);
            setCovers((current) => new Map(current).set(`${connectionKey}:${work.id}`, url));
          }
        } catch {
          // Optional artwork must never block the library or emit a notification.
        } finally {
          clearTimeout(timeout);
          abort.signal.removeEventListener('abort', cancel);
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, pending.length) }, run));
    return () => abort.abort();
  }, [targets, connectionKey, resolve]);
  return useMemo(
    () =>
      works.map((work) => {
        const thumbnailUrl = work.thumbnailUrl ?? covers.get(`${connectionKey}:${work.id}`);
        return thumbnailUrl === work.thumbnailUrl ? work : { ...work, thumbnailUrl };
      }),
    [works, covers, connectionKey],
  );
}
