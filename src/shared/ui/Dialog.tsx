import { X } from 'lucide-react';
import { type MouseEvent, type ReactNode, type RefObject, useId, useRef } from 'react';
import { useDismissibleLayer } from './use-dismissible-layer';

export type DialogCloseReason = 'backdrop' | 'close-button' | 'escape';

export interface DialogProps {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  onClose(reason: DialogCloseReason): void;
  ariaDescriptionId?: string;
  className?: string;
  backdropClassName?: string;
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
  backdropClassName,
  closeLabel = '대화상자 닫기',
  closeDisabled = false,
  initialFocusRef,
}: DialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDismissibleLayer({
    open,
    modal: true,
    containerRef: dialogRef,
    layerRootRef: backdropRef,
    initialFocusRef,
    closeDisabled,
    onClose,
  });

  if (!open) return null;

  const requestClose = (reason: DialogCloseReason) => {
    if (!closeDisabled) onClose(reason);
  };
  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) requestClose('backdrop');
  };

  return (
    <div ref={backdropRef} className={classNames('modal-backdrop', backdropClassName)} onClick={closeFromBackdrop}>
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
