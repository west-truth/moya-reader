import { AlertCircle, AlertTriangle, CheckCircle2, Info, X, type LucideIcon } from 'lucide-react';
import { useRef, useState, type PointerEvent } from 'react';
import type { ToastHostProps, ToastMessage, ToastTone } from './toast-controller';
export type { ToastAction, ToastController, ToastHostProps, ToastMessage, ToastTone } from './toast-controller';

const toneIcons: Record<ToastTone, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle,
};

const SWIPE_DISMISS_PX = 64;

function ToastItem({ toast, onDismiss }: { toast: ToastMessage; onDismiss?(id: string): void }) {
  const Icon = toneIcons[toast.tone];
  const start = useRef<{ x: number; pointer: number }>();
  const [offset, setOffset] = useState(0);
  // Touch users flick a toast sideways to clear it, as with native notifications.
  const swipe = onDismiss
    ? {
        onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
          if (event.pointerType === 'mouse' || (event.target as HTMLElement).closest('button')) return;
          start.current = { x: event.clientX, pointer: event.pointerId };
        },
        onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
          if (start.current?.pointer === event.pointerId) setOffset(event.clientX - start.current.x);
        },
        onPointerUp: () => {
          if (Math.abs(offset) > SWIPE_DISMISS_PX) onDismiss(toast.id);
          else setOffset(0);
          start.current = undefined;
        },
        onPointerCancel: () => {
          start.current = undefined;
          setOffset(0);
        },
      }
    : undefined;
  return (
    <div
      className={`toast ${toast.tone}`}
      data-leaving={toast.leaving || undefined}
      role={toast.tone === 'danger' ? 'alert' : 'status'}
      aria-atomic="true"
      style={
        offset
          ? { transform: `translateX(${offset}px)`, opacity: 1 - Math.min(Math.abs(offset) / 160, 0.7) }
          : undefined
      }
      {...swipe}
    >
      <Icon className="toast-icon" size={18} aria-hidden="true" />
      <span className="toast-message">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            onDismiss?.(toast.id);
            void toast.action?.onSelect();
          }}
        >
          {toast.action.label}
        </button>
      )}
      {onDismiss && (
        <button type="button" className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="알림 닫기">
          <X size={15} />
        </button>
      )}
    </div>
  );
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
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
