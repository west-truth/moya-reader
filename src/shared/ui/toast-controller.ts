import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastAction {
  label: string;
  onSelect(): void | Promise<void>;
}

export interface ToastMessage {
  id: string;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
  /** Set while the toast animates out; it is removed shortly after. */
  leaving?: boolean;
}

export interface ToastHostProps {
  toasts: readonly ToastMessage[];
  readerActive: boolean;
  addonOpen: boolean;
  onDismiss?(id: string): void;
}

export interface ToastController {
  toasts: readonly ToastMessage[];
  showToast(message: string, tone?: ToastTone, action?: ToastAction): string;
  dismissToast(id: string): void;
}

/** Overflow removes routine messages first; errors and actions keep their allotted time. */
export const MAX_VISIBLE_TOASTS = 3;
const TOAST_EXIT_MS = 180;
const ACTION_TOAST_MS = 8000;

/** Reading time scales with length so long messages are not cut off mid-sentence. */
export function toastAutoDismissDelay(
  tone: ToastTone,
  action: ToastAction | undefined,
  defaultDurationMs: number,
  message = '',
): number {
  if (action) return ACTION_TOAST_MS;
  const readingTime = Math.min(7000, 1200 + message.length * 55);
  const base = Math.max(defaultDurationMs, readingTime);
  return tone === 'danger' ? Math.max(base, 6000) : base;
}

export function useToastController(durationMs = 2800): ToastController {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const sequenceRef = useRef(0);
  const timersRef = useRef(new Map<string, number>());
  const toastsRef = useRef<ToastMessage[]>([]);
  // Every change goes through here so the ref and state never disagree between rapid calls.
  const commit = useCallback((update: (previous: ToastMessage[]) => ToastMessage[]) => {
    toastsRef.current = update(toastsRef.current);
    setToasts(toastsRef.current);
  }, []);

  const clearTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timersRef.current.delete(id);
  }, []);

  const dismissToast = useCallback(
    (id: string) => {
      clearTimer(id);
      commit((previous) => previous.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)));
      window.setTimeout(() => commit((previous) => previous.filter((toast) => toast.id !== id)), TOAST_EXIT_MS);
    },
    [clearTimer, commit],
  );

  const schedule = useCallback(
    (id: string, delay: number) => {
      clearTimer(id);
      timersRef.current.set(
        id,
        window.setTimeout(() => dismissToast(id), delay),
      );
    },
    [clearTimer, dismissToast],
  );

  const showToast = useCallback(
    (message: string, tone: ToastTone = 'info', action?: ToastAction) => {
      const delay = toastAutoDismissDelay(tone, action, durationMs, message);
      // Repeating a message that is already on screen just keeps it there longer.
      const duplicate = toastsRef.current.find(
        (toast) => !toast.leaving && toast.message === message && toast.tone === tone && !toast.action && !action,
      );
      if (duplicate) {
        schedule(duplicate.id, delay);
        return duplicate.id;
      }
      sequenceRef.current += 1;
      const id = `toast-${Date.now()}-${sequenceRef.current}`;
      const visible = toastsRef.current.filter((toast) => !toast.leaving);
      const overflow = visible.length + 1 - MAX_VISIBLE_TOASTS;
      if (overflow > 0) {
        visible
          .filter((toast) => toast.tone !== 'danger' && !toast.action)
          .slice(0, overflow)
          .forEach((toast) => dismissToast(toast.id));
      }
      commit((previous) => [...previous, { id, message, tone, action }]);
      schedule(id, delay);
      return id;
    },
    [commit, dismissToast, durationMs, schedule],
  );

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) window.clearTimeout(timer);
      timersRef.current.clear();
    },
    [],
  );

  return { toasts, showToast, dismissToast };
}
