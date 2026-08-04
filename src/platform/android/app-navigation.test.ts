import { describe, expect, it, vi } from 'vitest';
import {
  dispatchAndroidBackEscape,
  handleAppBackNavigation,
  isAndroidBackKeyboardEvent,
  resolveReaderTransientBackAction,
} from './app-navigation';

describe('Android app back navigation', () => {
  it('dismisses only the first open layer before changing screens', () => {
    const first = vi.fn();
    const second = vi.fn();
    const returnToChapters = vi.fn();
    const result = handleAppBackNavigation({
      layers: [
        { id: 'first', open: true, dismiss: first },
        { id: 'second', open: true, dismiss: second },
      ],
      view: 'reader',
      returnToChapters,
      returnToLibrary: vi.fn(),
    });

    expect(result).toEqual({ handled: true, action: 'dismiss-layer', layerId: 'first' });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(returnToChapters).not.toHaveBeenCalled();
  });

  it('moves Reader to Chapters and chapter/document screens to Library, leaving Library to the native shell', () => {
    const returnToChapters = vi.fn();
    const returnToLibrary = vi.fn();
    expect(handleAppBackNavigation({ layers: [], view: 'reader', returnToChapters, returnToLibrary })).toMatchObject({
      action: 'reader-to-chapters',
      handled: true,
    });
    expect(handleAppBackNavigation({ layers: [], view: 'chapters', returnToChapters, returnToLibrary })).toMatchObject({
      action: 'chapters-to-library',
      handled: true,
    });
    expect(handleAppBackNavigation({ layers: [], view: 'document', returnToChapters, returnToLibrary })).toMatchObject({
      action: 'document-to-library',
      handled: true,
    });
    expect(handleAppBackNavigation({ layers: [], view: 'library', returnToChapters, returnToLibrary })).toEqual({
      action: 'unhandled',
      handled: false,
    });
    expect(returnToChapters).toHaveBeenCalledOnce();
    expect(returnToLibrary).toHaveBeenCalledTimes(2);
  });

  it('marks the synthetic Escape so dismissible UI can consume Android back first', () => {
    const event = new Event('keydown', { bubbles: true, cancelable: true }) as KeyboardEvent;
    Object.defineProperty(event, 'key', { value: 'Escape' });
    const dispatchEvent = vi.fn((received: Event) => {
      expect(isAndroidBackKeyboardEvent(received as KeyboardEvent)).toBe(true);
      received.preventDefault();
      return false;
    });

    expect(dispatchAndroidBackEscape({ dispatchEvent }, () => event)).toBe(true);
    expect(dispatchEvent).toHaveBeenCalledWith(event);
  });

  it('keeps transient Reader UI ahead of route navigation', () => {
    const baseline = { overflowOpen: false, selectionOpen: false, mobileSearchOpen: false, searchActive: false };
    expect(resolveReaderTransientBackAction({ ...baseline, searchActive: true })).toBe('clear-search');
    expect(resolveReaderTransientBackAction({ ...baseline, mobileSearchOpen: true, searchActive: true })).toBe(
      'close-mobile-search',
    );
    expect(resolveReaderTransientBackAction({ ...baseline, selectionOpen: true, mobileSearchOpen: true })).toBe(
      'close-selection',
    );
    expect(resolveReaderTransientBackAction({ ...baseline, overflowOpen: true, selectionOpen: true })).toBe(
      'close-overflow',
    );
    expect(resolveReaderTransientBackAction(baseline)).toBe('delegate');
  });
});
