import { useCallback, useEffect, useRef, useState } from 'react';

/** Accepted saves belong to the reader session, not the episode currently on screen. */
export function useStreamSaveQueue<T>(options: {
  key(item: T): string;
  ready(item: T): boolean;
  save(item: T): Promise<void>;
}) {
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef(
    new Map<
      string,
      {
        item: T;
        promise: Promise<void>;
        resolve(): void;
        reject(error: unknown): void;
      }
    >(),
  );
  const running = useRef(false);
  const [version, wake] = useState(0);
  const pump = useCallback(() => {
    const next = pending.current.entries().next().value;
    if (running.current || !next || !latest.current.ready(next[1].item)) return;
    const [key, request] = next;
    running.current = true;
    void Promise.resolve()
      .then(() => {
        if (pending.current.get(key) !== request) throw new DOMException('Cancelled', 'AbortError');
        return latest.current.save(request.item);
      })
      .then(request.resolve, request.reject)
      .finally(() => {
        if (pending.current.get(key) === request) pending.current.delete(key);
        running.current = false;
        wake((value) => value + 1);
      });
  }, []);
  const enqueue = useCallback(
    (item: T) => {
      const key = latest.current.key(item);
      const existing = pending.current.get(key);
      if (existing) return existing.promise;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      pending.current.set(key, { item, promise, resolve, reject });
      pump();
      return promise;
    },
    [pump],
  );
  useEffect(pump, [options, version, pump]);
  const cancel = useCallback(() => {
    for (const request of pending.current.values()) request.reject(new DOMException('Cancelled', 'AbortError'));
    pending.current.clear();
  }, []);
  useEffect(() => cancel, [cancel]);
  return { enqueue, cancel };
}
