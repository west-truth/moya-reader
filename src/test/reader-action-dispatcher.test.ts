import { describe, expect, it, vi } from 'vitest';
import { dispatchReaderAction, gestureAction } from '../features/reader/reader-action-dispatcher';
import { DEFAULT_GESTURE_BINDINGS } from '../features/reader-settings/reading-profile';

describe('reader action dispatcher', () => {
  it('maps tap zones and horizontal swipes without stealing vertical intent', () => {
    const base = { bindings: DEFAULT_GESTURE_BINDINGS, viewportWidth: 300, durationMs: 100 };
    expect(gestureAction({ ...base, startX: 100, startY: 100, endX: 10, endY: 102 })).toBe('next_page');
    expect(gestureAction({ ...base, startX: 80, startY: 100, endX: 200, endY: 104 })).toBe('previous_page');
    expect(gestureAction({ ...base, startX: 150, startY: 100, endX: 151, endY: 180 })).toBeUndefined();
    expect(gestureAction({ ...base, startX: 150, startY: 100, endX: 151, endY: 101 })).toBe('toggle_chrome');
  });

  it('routes actions through one handler contract', () => {
    const handlers = {
      previousPage: vi.fn(),
      nextPage: vi.fn(),
      toggleChrome: vi.fn(),
      openToc: vi.fn(),
      openSettings: vi.fn(),
      toggleTTS: vi.fn(),
    };
    expect(dispatchReaderAction('open_toc', handlers)).toBe(true);
    expect(handlers.openToc).toHaveBeenCalledOnce();
    expect(dispatchReaderAction('none', handlers)).toBe(false);
  });
});
