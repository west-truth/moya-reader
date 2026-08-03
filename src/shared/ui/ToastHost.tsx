import { X } from 'lucide-react';
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

export function toastAutoDismissDelay(
  tone: ToastTone,
  action: ToastAction | undefined,
  defaultDurationMs: number,
): number | undefined {
  if (action) return undefined;
  return tone === 'danger' ? Math.max(defaultDurationMs, 6000) : defaultDurationMs;
}

export function useToastController(durationMs = 2800): ToastController {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const sequenceRef = useRef(0);
  const timersRef = useRef(new Map<string, number>());

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timersRef.current.delete(id);
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, tone: ToastTone = 'info', action?: ToastAction) => {
      sequenceRef.current += 1;
      const id = `toast-${Date.now()}-${sequenceRef.current}`;
      setToasts((previous) => [...previous, { id, message, tone, action }]);
      const delay = toastAutoDismissDelay(tone, action, durationMs);
      if (delay !== undefined) {
        const timer = window.setTimeout(() => dismissToast(id), delay);
        timersRef.current.set(id, timer);
      }
      return id;
    },
    [dismissToast, durationMs],
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

function classNames(...values: Array<string | false>): string {
  return values.filter(Boolean).join(' ');
}

export function ToastHost({ toasts, readerActive, addonOpen, onDismiss }: ToastHostProps) {
  return (
    <div
      className="toast-region"
      data-reader-active={readerActive}
      data-addon-open={addonOpen}
      aria-label="알림"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={classNames('toast', toast.tone)}
          role={toast.tone === 'danger' ? 'alert' : 'status'}
          aria-atomic="true"
        >
          <span>{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                onDismiss?.(toast.id);
                void toast.action?.onSelect();
              }}
            >
              {toast.action.label}
            </button>
          )}
          {onDismiss && (
            <button type="button" onClick={() => onDismiss(toast.id)} aria-label="알림 닫기">
              <X size={15} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
