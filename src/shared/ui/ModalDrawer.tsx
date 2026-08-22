import { X } from 'lucide-react';
import { type MouseEvent, type ReactNode, type RefObject, useId, useRef } from 'react';
import { useDismissibleLayer } from './use-dismissible-layer';

export type ModalDrawerCloseReason = 'backdrop' | 'close-button' | 'escape';

export interface ModalDrawerProps {
  readonly open: boolean;
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly onClose: (reason: ModalDrawerCloseReason) => void;
  readonly ariaDescriptionId?: string;
  readonly className?: string;
  readonly closeLabel?: string;
  readonly closeDisabled?: boolean;
  readonly initialFocusRef?: RefObject<HTMLElement>;
  readonly restoreFocusRef?: RefObject<HTMLElement>;
  readonly side?: 'start' | 'end';
  readonly footer?: ReactNode;
}

function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function ModalDrawer({
  open,
  title,
  children,
  onClose,
  ariaDescriptionId,
  className,
  closeLabel = '메뉴 닫기',
  closeDisabled = false,
  initialFocusRef,
  restoreFocusRef,
  side = 'start',
  footer,
}: ModalDrawerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useDismissibleLayer({
    open,
    modal: true,
    containerRef: drawerRef,
    layerRootRef: layerRef,
    initialFocusRef: initialFocusRef ?? closeRef,
    restoreFocusRef,
    closeDisabled,
    onClose,
  });

  if (!open) return null;

  const requestClose = (reason: ModalDrawerCloseReason) => {
    if (!closeDisabled) onClose(reason);
  };
  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) requestClose('backdrop');
  };

  return (
    <div ref={layerRef} className="modal-drawer-layer" data-side={side} onClick={closeFromBackdrop}>
      <aside
        ref={drawerRef}
        className={classNames('modal-drawer', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={ariaDescriptionId}
        tabIndex={-1}
      >
        <header className="modal-drawer-header">
          <h2 id={titleId}>{title}</h2>
          <button
            ref={closeRef}
            className="icon-btn"
            type="button"
            onClick={() => requestClose('close-button')}
            disabled={closeDisabled}
            aria-label={closeLabel}
          >
            <X size={18} />
          </button>
        </header>
        <div className="modal-drawer-content">{children}</div>
        {footer !== undefined && <footer className="modal-drawer-footer">{footer}</footer>}
      </aside>
    </div>
  );
}
