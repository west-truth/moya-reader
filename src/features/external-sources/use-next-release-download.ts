import { useEffect, useRef, useState } from 'react';

const KEY = 'noveldesk.next-release-download.v1';
const COUNT_KEY = 'noveldesk.next-release-download-count.v1';
export type NextReleaseCount = 1 | 2 | 3;

/** One attempt per reading section. A commit must never start a chain of downloads. */
export function useNextReleaseDownload(input: {
  readingKey?: string;
  busy: boolean;
  run(signal: AbortSignal, count: NextReleaseCount): Promise<void>;
  reportError(): void;
}) {
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem(KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [count, updateCount] = useState<NextReleaseCount>(() => {
    try {
      const value = Number(localStorage.getItem(COUNT_KEY));
      return value === 2 || value === 3 ? value : 1;
    } catch {
      return 1;
    }
  });
  const latest = useRef(input);
  latest.current = input;
  const attempted = useRef<string>();
  const running = useRef(false);
  const activeAbort = useRef<AbortController>();
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    attempted.current = undefined;
    return () => activeAbort.current?.abort();
  }, [enabled, count, input.readingKey]);
  useEffect(() => {
    if (!enabled || !input.readingKey) {
      attempted.current = undefined;
      return;
    }
    if (input.busy || running.current || attempted.current === input.readingKey) return;
    const abort = new AbortController();
    activeAbort.current = abort;
    const key = input.readingKey;
    attempted.current = key;
    running.current = true;
    void latest.current
      .run(abort.signal, count)
      .catch(() => {
        if (!abort.signal.aborted) latest.current.reportError();
      })
      .finally(() => {
        running.current = false;
        setSettled((value) => value + 1);
      });
  }, [enabled, count, input.readingKey, input.busy, settled]);
  return {
    enabled,
    count,
    setCount(value: NextReleaseCount) {
      if (![1, 2, 3].includes(value)) return;
      try {
        localStorage.setItem(COUNT_KEY, String(value));
      } catch {
        /* session preference */
      }
      updateCount(value);
    },
    setEnabled(value: boolean) {
      try {
        localStorage.setItem(KEY, String(value));
      } catch {
        /* session preference still works */
      }
      setEnabled(value);
    },
  };
}
