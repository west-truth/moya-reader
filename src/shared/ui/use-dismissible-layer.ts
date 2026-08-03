import { useEffect, useRef, useState, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true',
  );
}

function focusLayerStart(container: HTMLElement, initialFocus?: HTMLElement | null): void {
  (initialFocus ?? focusableElements(container)[0] ?? container).focus();
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}

export function useDismissibleLayer(input: {
  readonly open: boolean;
  readonly modal: boolean;
  readonly containerRef: RefObject<HTMLElement>;
  readonly initialFocusRef?: RefObject<HTMLElement>;
  readonly onClose: () => void;
}): void {
  const onCloseRef = useRef(input.onClose);
  onCloseRef.current = input.onClose;

  useEffect(() => {
    if (!input.open) return;
    const container = input.containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousBodyOverflow = document.body.style.overflow;
    if (input.modal) document.body.style.overflow = 'hidden';
    const focusFrame = window.requestAnimationFrame(() =>
      focusLayerStart(container, input.initialFocusRef?.current),
    );

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (!input.modal || event.key !== 'Tab') return;

      const elements = focusableElements(container);
      const activeIndex = elements.indexOf(document.activeElement as HTMLElement);
      const atStart = event.shiftKey && activeIndex <= 0;
      const atEnd = !event.shiftKey && activeIndex === elements.length - 1;
      if (!atStart && !atEnd && activeIndex >= 0) return;

      event.preventDefault();
      const target = event.shiftKey ? elements.at(-1) : elements[0];
      (target ?? container).focus();
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!input.modal || container.contains(event.target as Node)) return;
      focusLayerStart(container, input.initialFocusRef?.current);
    };

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      if (input.modal) document.body.style.overflow = previousBodyOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [input.containerRef, input.initialFocusRef, input.modal, input.open]);
}
