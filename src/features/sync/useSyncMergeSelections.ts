import { useCallback, useState } from 'react';

export type SyncMergeSelections = Readonly<Record<string, Readonly<Record<string, boolean>>>>;

export function updateSyncMergeSelection(
  current: SyncMergeSelections,
  groupKey: string,
  diffKey: string,
  checked: boolean,
): SyncMergeSelections {
  const group = { ...(current[groupKey] ?? {}) };
  if (checked) group[diffKey] = true;
  else delete group[diffKey];
  const next = { ...current };
  if (Object.keys(group).length) next[groupKey] = group;
  else delete next[groupKey];
  return next;
}

export function clearSyncMergeSelection(current: SyncMergeSelections, groupKey: string): SyncMergeSelections {
  if (!current[groupKey]) return current;
  const next = { ...current };
  delete next[groupKey];
  return next;
}

export function useSyncMergeSelections() {
  const [selections, setSelections] = useState<SyncMergeSelections>({});

  const setSelection = useCallback((groupKey: string, diffKey: string, checked: boolean) => {
    setSelections((current) => updateSyncMergeSelection(current, groupKey, diffKey, checked));
  }, []);

  const clearGroup = useCallback((groupKey: string) => {
    setSelections((current) => clearSyncMergeSelection(current, groupKey));
  }, []);

  return { selections, setSelection, clearGroup } as const;
}
