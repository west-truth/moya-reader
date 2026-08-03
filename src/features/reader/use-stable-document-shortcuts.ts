import { useEffect, useRef } from 'react';

export function isInteractiveShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest('input, textarea, select, button, [contenteditable="true"], [role="textbox"], [role="dialog"]'),
  );
}

export interface ShortcutEventTarget {
  addEventListener(type: 'keydown', listener: (event: globalThis.KeyboardEvent) => void): void;
  removeEventListener(type: 'keydown', listener: (event: globalThis.KeyboardEvent) => void): void;
}

export class StableDocumentShortcutBinding {
  private callback: (event: globalThis.KeyboardEvent) => void;
  private readonly listener = (event: globalThis.KeyboardEvent) => this.callback(event);

  constructor(callback: (event: globalThis.KeyboardEvent) => void) {
    this.callback = callback;
  }

  update(callback: (event: globalThis.KeyboardEvent) => void): void {
    this.callback = callback;
  }

  attach(target: ShortcutEventTarget): () => void {
    target.addEventListener('keydown', this.listener);
    return () => target.removeEventListener('keydown', this.listener);
  }
}

export function useStableDocumentShortcuts(
  enabled: boolean,
  onKeyDown: (event: globalThis.KeyboardEvent) => void,
): void {
  const bindingRef = useRef<StableDocumentShortcutBinding>();
  if (!bindingRef.current) bindingRef.current = new StableDocumentShortcutBinding(onKeyDown);
  bindingRef.current.update(onKeyDown);
  const binding = bindingRef.current;
  useEffect(() => {
    if (!enabled) return;
    return binding.attach(document);
  }, [binding, enabled]);
}
