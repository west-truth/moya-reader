import { useEffect, useRef } from 'react';

export interface ReaderLifecycleEvents {
  readonly isHidden: () => boolean;
  readonly subscribeVisibilityChange: (listener: () => void) => () => void;
  readonly subscribePageHide: (listener: () => void) => () => void;
}

export type ReaderBoundaryFlush = () => Promise<void> | void | undefined;

export async function flushReaderBoundary(...flushes: readonly ReaderBoundaryFlush[]): Promise<void> {
  await Promise.allSettled(flushes.map((flush) => Promise.resolve().then(flush)));
}

export function bindReaderLifecycleFlush(events: ReaderLifecycleEvents, flush: ReaderBoundaryFlush): () => void {
  let disposed = false;
  const run = () => {
    if (disposed) return;
    void Promise.resolve()
      .then(flush)
      .catch(() => undefined);
  };
  const unsubscribeVisibility = events.subscribeVisibilityChange(() => {
    if (events.isHidden()) run();
  });
  const unsubscribePageHide = events.subscribePageHide(run);

  return () => {
    if (disposed) return;
    unsubscribeVisibility();
    unsubscribePageHide();
    run();
    disposed = true;
  };
}

function browserReaderLifecycleEvents(): ReaderLifecycleEvents {
  return {
    isHidden: () => document.visibilityState === 'hidden',
    subscribeVisibilityChange: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    subscribePageHide: (listener) => {
      window.addEventListener('pagehide', listener);
      return () => window.removeEventListener('pagehide', listener);
    },
  };
}

export function useReaderLifecycleFlush(flush: ReaderBoundaryFlush): void {
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => bindReaderLifecycleFlush(browserReaderLifecycleEvents(), () => flushRef.current()), []);
}
