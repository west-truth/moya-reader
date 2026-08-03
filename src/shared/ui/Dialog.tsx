import { X } from 'lucide-react';
import { type MouseEvent, type ReactNode, type RefObject, useEffect, useId, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export type DialogCloseReason = 'backdrop' | 'close-button' | 'escape';

export interface DialogProps {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  onClose(reason: DialogCloseReason): void;
  ariaDescriptionId?: string;
  className?: string;
  closeLabel?: string;
  closeDisabled?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
}

export function trappedFocusTargetIndex(
  activeIndex: number,
  focusableCount: number,
  backwards: boolean,
): number | undefined {
  if (focusableCount <= 0) return -1;
  if (activeIndex < 0) return backwards ? focusableCount - 1 : 0;
  if (backwards && activeIndex === 0) return focusableCount - 1;
  if (!backwards && activeIndex === focusableCount - 1) return 0;
  return undefined;
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true',
  );
}

function focusDialogStart(dialog: HTMLElement, initialFocus?: HTMLElement | null): void {
  const target =
    initialFocus ??
    dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]') ??
    focusableElements(dialog)[0] ??
    dialog;
  target.focus();
}

function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function Dialog({
  open,
  title,
  children,
  onClose,
  ariaDescriptionId,
  className,
  closeLabel = '대화상자 닫기',
  closeDisabled = false,
  initialFocusRef,
}: DialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  onCloseRef.current = onClose;
  closeDisabledRef.current = closeDisabled;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFrame = window.requestAnimationFrame(() => focusDialogStart(dialog, initialFocusRef?.current));

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !closeDisabledRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current('escape');
        return;
      }
      if (event.key !== 'Tab') return;

      const elements = focusableElements(dialog);
      const activeIndex = elements.indexOf(document.activeElement as HTMLElement);
      const targetIndex = trappedFocusTargetIndex(activeIndex, elements.length, event.shiftKey);
      if (targetIndex === undefined) return;

      event.preventDefault();
      if (targetIndex < 0) dialog.focus();
      else elements[targetIndex]?.focus();
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (dialog.contains(event.target as Node)) return;
      focusDialogStart(dialog, initialFocusRef?.current);
    };

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      document.body.style.overflow = previousBodyOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [initialFocusRef, open]);

  if (!open) return null;

  const requestClose = (reason: DialogCloseReason) => {
    if (!closeDisabled) onClose(reason);
  };
  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) requestClose('backdrop');
  };

  return (
    <div className="modal-backdrop" onClick={closeFromBackdrop}>
      <section
        ref={dialogRef}
        className={classNames('modal', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={ariaDescriptionId}
        tabIndex={-1}
      >
        <header>
          <h2 id={titleId}>{title}</h2>
          <button
            className="icon-btn"
            type="button"
            onClick={() => requestClose('close-button')}
            disabled={closeDisabled}
            aria-label={closeLabel}
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
