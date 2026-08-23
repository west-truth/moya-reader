import { useEffect, useRef, useState, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export type DismissibleLayerCloseReason = 'escape';

interface LayerRegistration {
  readonly isTop: () => boolean;
  readonly release: () => void;
}

export interface DismissibleLayerStack {
  readonly register: () => LayerRegistration;
  readonly size: () => number;
}

export function createDismissibleLayerStack(): DismissibleLayerStack {
  const layers: symbol[] = [];
  return {
    register() {
      const layer = Symbol('dismissible-layer');
      layers.push(layer);
      let active = true;
      return {
        isTop: () => active && layers.at(-1) === layer,
        release: () => {
          if (!active) return;
          active = false;
          const index = layers.indexOf(layer);
          if (index >= 0) layers.splice(index, 1);
        },
      };
    },
    size: () => layers.length,
  };
}

const dismissibleLayerStack = createDismissibleLayerStack();

let bodyLockCount = 0;
let bodyOverflowBeforeLock = '';

function acquireBodyLock(): () => void {
  if (bodyLockCount === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  bodyLockCount += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    bodyLockCount = Math.max(0, bodyLockCount - 1);
    if (bodyLockCount === 0) document.body.style.overflow = bodyOverflowBeforeLock;
  };
}

interface InertState {
  count: number;
  readonly initiallyInert: boolean;
}

const inertStates = new WeakMap<HTMLElement, InertState>();

function outsideElements(layerRoot: HTMLElement): HTMLElement[] {
  const outside = new Set<HTMLElement>();
  let current: HTMLElement | null = layerRoot;
  while (current?.parentElement && current.parentElement !== document.body) {
    for (const sibling of current.parentElement.children) {
      if (sibling !== current && sibling instanceof HTMLElement) outside.add(sibling);
    }
    current = current.parentElement;
  }
  if (current?.parentElement === document.body) {
    for (const sibling of document.body.children) {
      if (sibling !== current && sibling instanceof HTMLElement) outside.add(sibling);
    }
  }
  return [...outside];
}

function acquireOutsideInert(layerRoot: HTMLElement): () => void {
  const elements = outsideElements(layerRoot);
  for (const element of elements) {
    const state = inertStates.get(element);
    if (state) state.count += 1;
    else {
      inertStates.set(element, { count: 1, initiallyInert: element.hasAttribute('inert') });
      element.setAttribute('inert', '');
    }
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const element of elements) {
      const state = inertStates.get(element);
      if (!state) continue;
      state.count -= 1;
      if (state.count > 0) continue;
      if (!state.initiallyInert) element.removeAttribute('inert');
      inertStates.delete(element);
    }
  };
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true',
  );
}

function focusLayerStart(container: HTMLElement, initialFocus?: HTMLElement | null): void {
  (
    initialFocus ??
    container.querySelector<HTMLElement>('[data-dialog-initial-focus]') ??
    focusableElements(container)[0] ??
    container
  ).focus();
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
  readonly layerRootRef?: RefObject<HTMLElement>;
  readonly initialFocusRef?: RefObject<HTMLElement>;
  readonly restoreFocusRef?: RefObject<HTMLElement>;
  readonly closeDisabled?: boolean;
  readonly onClose: (reason: DismissibleLayerCloseReason) => void;
}): void {
  const onCloseRef = useRef(input.onClose);
  const closeDisabledRef = useRef(input.closeDisabled);
  onCloseRef.current = input.onClose;
  closeDisabledRef.current = input.closeDisabled;

  useEffect(() => {
    if (!input.open) return;
    const container = input.containerRef.current;
    if (!container) return;

    const registration = dismissibleLayerStack.register();
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const releaseBodyLock = input.modal ? acquireBodyLock() : undefined;
    const layerRoot = input.layerRootRef?.current;
    const releaseOutsideInert = input.modal && layerRoot ? acquireOutsideInert(layerRoot) : undefined;
    const focusFrame = window.requestAnimationFrame(() => focusLayerStart(container, input.initialFocusRef?.current));

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!registration.isTop()) return;
      if (event.key === 'Escape' && !closeDisabledRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current('escape');
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
      if (!registration.isTop() || !input.modal || container.contains(event.target as Node)) return;
      focusLayerStart(container, input.initialFocusRef?.current);
    };

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      registration.release();
      releaseOutsideInert?.();
      releaseBodyLock?.();
      const restoreTarget = input.restoreFocusRef?.current ?? previouslyFocused;
      if (restoreTarget?.isConnected) restoreTarget.focus();
    };
  }, [input.containerRef, input.initialFocusRef, input.layerRootRef, input.modal, input.open, input.restoreFocusRef]);
}
