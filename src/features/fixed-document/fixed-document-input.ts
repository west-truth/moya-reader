const INTERACTIVE_SELECTOR =
  'a,button,input,select,textarea,label,[role="button"],[contenteditable="true"],.fixed-doc-text-layer,.fixed-doc-region-select-layer';

export function isFixedDocumentInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(INTERACTIVE_SELECTOR));
}

export function parseFixedDocumentPageDraft(draft: string, totalPages: number): number | undefined {
  const trimmed = draft.trim();
  const value = Number(trimmed);
  if (!trimmed || !Number.isSafeInteger(value)) return undefined;
  return Math.max(0, Math.min(Math.max(0, totalPages - 1), value - 1));
}

export type FixedDocumentPanAxis = 'x' | 'y' | 'both';

export function fixedDocumentPanAxis(input: {
  readonly zoom: number;
  readonly continuousView: boolean;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
}): FixedDocumentPanAxis | undefined {
  if (input.zoom > 1.02) return 'both';
  if (input.continuousView) return undefined;
  const horizontal = Math.abs(input.deltaX);
  const vertical = Math.abs(input.deltaY);
  if (Math.max(horizontal, vertical) < 6) return undefined;
  if (vertical > horizontal && input.scrollHeight > input.clientHeight + 2) return 'y';
  if (horizontal >= vertical && input.scrollWidth > input.clientWidth + 2) return 'x';
  return undefined;
}

export function handleFixedDocumentKeyDown(
  event: KeyboardEvent,
  actions: {
    readonly rtl: boolean;
    readonly dismiss: () => boolean;
    readonly turnPage: (step: -1 | 1) => void;
    readonly toggleImmersive: () => void;
    readonly toggleFullscreen: () => void;
    readonly zoomBy: (delta: number) => void;
  },
): void {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.key === 'Escape') {
    if (actions.dismiss()) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey || isFixedDocumentInteractiveTarget(event.target)) return;
  switch (event.key.toLowerCase()) {
    case 'arrowleft':
      actions.turnPage(actions.rtl ? 1 : -1);
      break;
    case 'arrowright':
      actions.turnPage(actions.rtl ? -1 : 1);
      break;
    case 'pageup':
      actions.turnPage(-1);
      break;
    case 'pagedown':
    case ' ':
      actions.turnPage(1);
      break;
    case 'i':
      actions.toggleImmersive();
      break;
    case 'f':
      actions.toggleFullscreen();
      break;
    case '+':
    case '=':
      actions.zoomBy(0.1);
      break;
    case '-':
      actions.zoomBy(-0.1);
      break;
    default:
      return;
  }
  event.preventDefault();
}
