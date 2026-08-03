import type { GestureBindings, ReaderAction } from '../../domain/types';

export interface ReaderActionHandlers {
  previousPage(): void;
  nextPage(): void;
  toggleChrome(): void;
  openToc(): void;
  openSettings(): void;
  toggleTTS(): void;
}

export function dispatchReaderAction(action: ReaderAction, handlers: ReaderActionHandlers): boolean {
  if (action === 'none') return false;
  if (action === 'previous_page') handlers.previousPage();
  else if (action === 'next_page') handlers.nextPage();
  else if (action === 'toggle_chrome') handlers.toggleChrome();
  else if (action === 'open_toc') handlers.openToc();
  else if (action === 'open_settings') handlers.openSettings();
  else if (action === 'toggle_tts') handlers.toggleTTS();
  return true;
}

export function gestureAction(input: {
  readonly bindings: GestureBindings;
  readonly viewportWidth: number;
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
  readonly durationMs: number;
}): ReaderAction | undefined {
  const deltaX = input.endX - input.startX;
  const deltaY = input.endY - input.startY;
  const swipe = Math.abs(deltaX) >= 52 && Math.abs(deltaX) > Math.abs(deltaY) * 1.35 && input.durationMs <= 700;
  if (swipe) return deltaX < 0 ? input.bindings.swipeLeft : input.bindings.swipeRight;
  if (Math.abs(deltaX) > 12 || Math.abs(deltaY) > 12 || input.durationMs > 500) return undefined;
  const zone = input.endX / Math.max(1, input.viewportWidth);
  if (zone < 0.33) return input.bindings.tapLeft;
  if (zone > 0.67) return input.bindings.tapRight;
  return input.bindings.tapCenter;
}

export function gestureTargetIsInteractive(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'a,button,input,select,textarea,label,[role="button"],[contenteditable="true"],.reader-selection-toolbar',
      ),
    )
  );
}
