import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchAndroidBackEscape } from '../../platform/android/app-navigation';
import {
  fixedDocumentPanAxis,
  handleFixedDocumentKeyDown,
  isFixedDocumentInteractiveTarget,
  parseFixedDocumentPageDraft,
} from './fixed-document-input';

class Target extends EventTarget {
  constructor(private readonly interactive: boolean) {
    super();
  }
  closest() {
    return this.interactive ? this : null;
  }
}

function keyboard(key: string, properties: Record<string, unknown> = {}): KeyboardEvent {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(
    event,
    Object.fromEntries(Object.entries({ key, ...properties }).map(([name, value]) => [name, { value }])),
  );
  return event as KeyboardEvent;
}

function actions() {
  return {
    rtl: false,
    dismiss: vi.fn(() => false),
    turnPage: vi.fn(),
    toggleImmersive: vi.fn(),
    toggleFullscreen: vi.fn(),
    zoomBy: vi.fn(),
  };
}

describe('fixed document input boundaries', () => {
  beforeEach(() => {
    vi.stubGlobal('Element', Target);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leaves interactive descendants to their own click and keyboard handlers', () => {
    const control = new Target(true);
    expect(isFixedDocumentInteractiveTarget(control)).toBe(true);
    expect(isFixedDocumentInteractiveTarget(new Target(false))).toBe(false);
    const handlers = actions();
    for (const key of [' ', 'ArrowRight', 'f']) {
      const event = keyboard(key, { target: control });
      handleFixedDocumentKeyDown(event, handlers);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(handlers.turnPage).not.toHaveBeenCalled();
    expect(handlers.toggleFullscreen).not.toHaveBeenCalled();
  });

  it('preserves browser shortcuts and IME composition while keeping ordinary reader keys', () => {
    const handlers = actions();
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
      const event = keyboard('f', modifiers);
      handleFixedDocumentKeyDown(event, handlers);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(handlers.toggleFullscreen).not.toHaveBeenCalled();
    const right = keyboard('ArrowRight');
    handleFixedDocumentKeyDown(right, { ...handlers, rtl: true });
    expect(handlers.turnPage).toHaveBeenCalledWith(-1);
    expect(right.defaultPrevented).toBe(true);
    const fullscreen = keyboard('f');
    handleFixedDocumentKeyDown(fullscreen, handlers);
    expect(handlers.toggleFullscreen).toHaveBeenCalledOnce();
  });

  it('dismisses from an input and consumes Android back only when a viewer layer closes', () => {
    const handlers = actions();
    handlers.dismiss.mockReturnValue(true);
    const inputEscape = keyboard('Escape', { target: new Target(true) });
    handleFixedDocumentKeyDown(inputEscape, handlers);
    expect(inputEscape.defaultPrevented).toBe(true);
    expect(handlers.dismiss).toHaveBeenCalledOnce();
    const dispatchTarget = {
      dispatchEvent(event: Event) {
        handleFixedDocumentKeyDown(event as KeyboardEvent, handlers);
        return !event.defaultPrevented;
      },
    };
    expect(dispatchAndroidBackEscape(dispatchTarget, () => keyboard('Escape'))).toBe(true);
    handlers.dismiss.mockReturnValue(false);
    expect(dispatchAndroidBackEscape(dispatchTarget, () => keyboard('Escape'))).toBe(false);
  });

  it('pans actual overflow at 100% without taking horizontal page swipes or native continuous scrolling', () => {
    const input = {
      zoom: 1,
      continuousView: false,
      deltaX: 2,
      deltaY: -100,
      scrollWidth: 390,
      clientWidth: 390,
      scrollHeight: 2000,
      clientHeight: 650,
    };
    expect(fixedDocumentPanAxis(input)).toBe('y');
    expect(fixedDocumentPanAxis({ ...input, deltaX: -100, deltaY: 2 })).toBeUndefined();
    expect(fixedDocumentPanAxis({ ...input, scrollHeight: 650 })).toBeUndefined();
    expect(fixedDocumentPanAxis({ ...input, continuousView: true })).toBeUndefined();
    expect(fixedDocumentPanAxis({ ...input, scrollWidth: 900, deltaX: -100, deltaY: 2 })).toBe('x');
    expect(fixedDocumentPanAxis({ ...input, zoom: 1.5 })).toBe('both');
    expect(fixedDocumentPanAxis({ ...input, deltaX: 1, deltaY: 2 })).toBeUndefined();
  });

  it('rejects invalid drafts while preserving finite whole-page bounds', () => {
    for (const draft of ['abc', '12페이지', '', ' ', 'NaN', 'Infinity', '1.5', '1e309']) {
      expect(parseFixedDocumentPageDraft(draft, 100)).toBeUndefined();
    }
    expect(parseFixedDocumentPageDraft(' 12 ', 100)).toBe(11);
    expect(parseFixedDocumentPageDraft('0', 100)).toBe(0);
    expect(parseFixedDocumentPageDraft('-4', 100)).toBe(0);
    expect(parseFixedDocumentPageDraft('101', 100)).toBe(99);
  });
});
