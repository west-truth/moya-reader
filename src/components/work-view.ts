import { useSyncExternalStore } from 'react';

export type WorkView = 'grid' | 'compact' | 'list' | 'text';
export const workViews = [
  ['grid', '표지'],
  ['compact', '작은 표지'],
  ['list', '목록'],
  ['text', '텍스트 목록'],
] as const;
export const isWorkView = (value: unknown): value is WorkView => workViews.some(([mode]) => mode === value);
export const isCoverView = (value: WorkView) => value === 'grid' || value === 'compact';

const memory = new Map<string, WorkView>();
const eventName = 'moya-work-view';
export function readWorkView(key: string, fallback: WorkView = 'grid'): WorkView {
  if (memory.has(key)) return memory.get(key)!;
  try {
    const value = localStorage.getItem(key);
    return isWorkView(value) ? value : fallback;
  } catch {
    return memory.get(key) ?? fallback;
  }
}
export function saveWorkView(key: string, value: WorkView) {
  try {
    localStorage.setItem(key, value);
    memory.delete(key);
  } catch {
    // Keep the current session usable when device storage is unavailable.
    memory.set(key, value);
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(eventName));
}
function subscribe(changed: () => void) {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => undefined;
  window.addEventListener(eventName, changed);
  window.addEventListener('storage', changed);
  return () => {
    window.removeEventListener(eventName, changed);
    window.removeEventListener('storage', changed);
  };
}
export function useWorkView(key: string, fallback: WorkView = 'grid') {
  const value = useSyncExternalStore(
    subscribe,
    () => readWorkView(key, fallback),
    () => fallback,
  );
  return [value, (next: WorkView) => saveWorkView(key, next)] as const;
}
