import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Novel } from '../../domain/types';
import {
  runBookEnrichmentBatch,
  type BookEnrichmentAutomaticApplyMode,
  type BookEnrichmentAutomationRunner,
  type BookEnrichmentBatchProgress,
  type BookEnrichmentBatchResult,
} from './book-enrichment-automation';

const IDLE_PROGRESS: BookEnrichmentBatchProgress = {
  state: 'idle',
  total: 0,
  completed: 0,
  matched: 0,
  applied: 0,
  failed: 0,
  skipped: 0,
};

export interface BookEnrichmentAutomationController {
  readonly progress: BookEnrichmentBatchProgress;
  readonly result?: BookEnrichmentBatchResult;
  readonly busy: boolean;
  runLibraryBatch(): Promise<BookEnrichmentBatchResult | undefined>;
  cancel(): void;
}

export interface UseBookEnrichmentAutomationInput {
  readonly ready: boolean;
  readonly enabled: boolean;
  readonly books: readonly Novel[];
  readonly runner?: BookEnrichmentAutomationRunner;
  readonly providerId: ExtensionContributionId;
  readonly automaticLookup: boolean;
  readonly automaticApply: BookEnrichmentAutomaticApplyMode;
  refreshLibrary(): Promise<unknown>;
  notify(message: string, tone?: 'info' | 'success' | 'warning' | 'danger'): void;
}

export function useBookEnrichmentAutomation(
  input: UseBookEnrichmentAutomationInput,
): BookEnrichmentAutomationController {
  const latest = useRef(input);
  latest.current = input;
  const observedBookIds = useRef<Set<string>>();
  const pendingAutomaticBooks = useRef(new Map<string, Novel>());
  const activeRun = useRef<AbortController>();
  const drainAutomaticQueueRef = useRef<() => void>(() => undefined);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const [progress, setProgress] = useState<BookEnrichmentBatchProgress>(IDLE_PROGRESS);
  const [result, setResult] = useState<BookEnrichmentBatchResult>();

  const run = useCallback(
    async (
      books: readonly Novel[],
      announce: boolean,
      automaticApply?: BookEnrichmentAutomaticApplyMode,
    ): Promise<BookEnrichmentBatchResult | undefined> => {
      const current = latest.current;
      if (!mountedRef.current || busyRef.current || !current.enabled || !current.runner) return undefined;
      busyRef.current = true;
      const controller = new AbortController();
      activeRun.current = controller;
      if (announce) setResult(undefined);
      try {
        const next = await runBookEnrichmentBatch({
          runner: current.runner,
          providerId: current.providerId,
          books,
          automaticApply: automaticApply ?? current.automaticApply,
          signal: controller.signal,
          onProgress: (next) => {
            if (mountedRef.current) setProgress(next);
          },
        });
        if (mountedRef.current) setResult(next);
        if (next.applied > 0 && mountedRef.current) await latest.current.refreshLibrary();
        if (!announce && mountedRef.current) {
          if (next.applied > 0) {
            latest.current.notify(`${next.applied}권의 빈 작품 정보와 표지를 자동으로 채웠습니다.`, 'success');
          } else if (next.matched > 0) {
            latest.current.notify(`${next.matched}권의 작품 정보 후보를 준비했습니다.`, 'info');
          } else if (next.failed > 0) {
            latest.current.notify('자동 작품 정보 검색을 완료하지 못했습니다.', 'warning');
          }
        }
        return next;
      } finally {
        if (activeRun.current === controller) activeRun.current = undefined;
        busyRef.current = false;
        queueMicrotask(() => drainAutomaticQueueRef.current());
      }
    },
    [],
  );

  const drainAutomaticQueue = useCallback(() => {
    const current = latest.current;
    if (
      !mountedRef.current ||
      busyRef.current ||
      pendingAutomaticBooks.current.size === 0 ||
      !current.enabled ||
      !current.automaticLookup ||
      !current.runner
    ) {
      return;
    }
    const queued = [...pendingAutomaticBooks.current.values()];
    pendingAutomaticBooks.current.clear();
    void run(queued, false);
  }, [run]);
  drainAutomaticQueueRef.current = drainAutomaticQueue;

  useEffect(() => {
    if (!input.ready) return;
    const currentIds = new Set(input.books.map((book) => book.id));
    if (!observedBookIds.current) {
      observedBookIds.current = currentIds;
      return;
    }
    const added = input.books.filter((book) => !observedBookIds.current!.has(book.id));
    observedBookIds.current = currentIds;
    if (!input.enabled || !input.automaticLookup || added.length === 0) return;
    for (const book of added) pendingAutomaticBooks.current.set(book.id, book);
    drainAutomaticQueue();
  }, [drainAutomaticQueue, input.automaticLookup, input.books, input.enabled, input.ready]);

  useEffect(() => {
    if (input.enabled && input.automaticLookup && input.runner) drainAutomaticQueue();
  }, [drainAutomaticQueue, input.automaticLookup, input.enabled, input.runner]);

  useEffect(() => {
    if (input.enabled) return;
    activeRun.current?.abort();
    pendingAutomaticBooks.current.clear();
  }, [input.enabled]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRun.current?.abort();
    };
  }, []);

  return useMemo(
    () => ({
      progress,
      result,
      busy: progress.state === 'running',
      runLibraryBatch: () => run(latest.current.books, true, 'missing_fields'),
      cancel: () => activeRun.current?.abort(),
    }),
    [progress, result, run],
  );
}
