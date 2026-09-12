import { useSyncExternalStore } from 'react';

export const WEB_DATA_SAFETY_KEY = 'moya-web-data-safety-v1';
export interface WebDataSafety {
  lastExportedAt?: number;
  introductionDismissed?: boolean;
}

export function parseWebDataSafety(raw: string | null): WebDataSafety {
  try {
    const parsed = JSON.parse(raw ?? '{}');
    const timestamp = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
    return {
      lastExportedAt: timestamp(parsed?.lastExportedAt),
      // Honor a previous dismissal when migrating the old weekly reminder.
      introductionDismissed: parsed?.introductionDismissed === true || timestamp(parsed?.dismissedUntil) !== undefined,
    };
  } catch {
    return {};
  }
}

function read(): WebDataSafety {
  try {
    return parseWebDataSafety(localStorage.getItem(WEB_DATA_SAFETY_KEY));
  } catch {
    return {};
  }
}
let snapshot: WebDataSafety | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
function changed(event: StorageEvent) {
  if (event.key === WEB_DATA_SAFETY_KEY || event.key === null) {
    snapshot = read();
    emit();
  }
}
function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener('storage', changed);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', changed);
  };
}
const getSnapshot = () => (snapshot ??= read());
export const useWebDataSafety = () => useSyncExternalStore(subscribe, getSnapshot);
function save(value: WebDataSafety) {
  snapshot = value;
  try {
    localStorage.setItem(WEB_DATA_SAFETY_KEY, JSON.stringify(value));
  } catch {
    /* A storage preference must not turn a completed backup into a failure. */
  }
  emit();
}
export function recordWebBackup(exportedAt: string) {
  const timestamp = Date.parse(exportedAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return;
  save({ ...getSnapshot(), lastExportedAt: timestamp });
}
export function dismissWebIntroduction() {
  save({ ...getSnapshot(), introductionDismissed: true });
}
