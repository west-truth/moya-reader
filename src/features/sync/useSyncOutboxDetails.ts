import { useCallback, useEffect, useRef, useState } from 'react';
import type { SyncRepository } from '../../repositories/reader-repository';
import { loadSyncOutboxDetails, type SyncOutboxDetails } from '../../sync/outbox-queries';

const EMPTY_DETAILS: SyncOutboxDetails = { items: [], truncated: false };

export function useSyncOutboxDetails(repository: SyncRepository, open: boolean, revision: string) {
  const [details, setDetails] = useState<SyncOutboxDetails>(EMPTY_DETAILS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const completeRequested = useRef(false);
  const previousRepository = useRef(repository);
  const refresh = useCallback(
    async (complete = false) => {
      const current = ++generation.current;
      setDetails(EMPTY_DETAILS);
      setLoading(true);
      setError(undefined);
      try {
        const next = await loadSyncOutboxDetails(repository, complete);
        if (generation.current === current) setDetails(next);
      } catch (error) {
        if (generation.current === current) setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (generation.current === current) setLoading(false);
      }
    },
    [repository],
  );
  useEffect(() => {
    if (!open || previousRepository.current !== repository) completeRequested.current = false;
    previousRepository.current = repository;
    if (open) void refresh(completeRequested.current);
    else {
      setDetails(EMPTY_DETAILS);
      setLoading(false);
      setError(undefined);
    }
    return () => {
      generation.current += 1;
    };
  }, [open, refresh, repository, revision]);
  return {
    ...details,
    loading,
    error,
    loadComplete: () => {
      completeRequested.current = true;
      return refresh(true);
    },
  };
}
