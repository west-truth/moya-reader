import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseWebDataSafety, recordWebBackup, WEB_DATA_SAFETY_KEY } from './web-data-safety';

afterEach(() => vi.unstubAllGlobals());
describe('Web local data preferences', () => {
  it('does not treat a corrupt preference as a completed backup', () => {
    expect(parseWebDataSafety('broken')).toEqual({});
    expect(parseWebDataSafety('{"lastExportedAt":"yesterday","dismissedUntil":-1}')).toEqual({
      lastExportedAt: undefined,
      introductionDismissed: false,
    });
    expect(parseWebDataSafety('null')).toEqual({ lastExportedAt: undefined, introductionDismissed: false });
  });
  it('honors previous dismissals without turning an existing backup into a dismissal', () => {
    expect(parseWebDataSafety('{"dismissedUntil":100}').introductionDismissed).toBe(true);
    expect(parseWebDataSafety('{"introductionDismissed":true}').introductionDismissed).toBe(true);
    expect(parseWebDataSafety('{"introductionDismissed":"true"}').introductionDismissed).toBe(false);
    expect(parseWebDataSafety('{"lastExportedAt":100}')).toEqual({
      lastExportedAt: 100,
      introductionDismissed: false,
    });
  });
  it('persists a one-time dismissal without changing the saved backup date', async () => {
    vi.resetModules();
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => '{"lastExportedAt":100}', setItem });
    const { dismissWebIntroduction } = await import('./web-data-safety');
    dismissWebIntroduction();
    expect(setItem).toHaveBeenCalledWith(
      WEB_DATA_SAFETY_KEY,
      JSON.stringify({ lastExportedAt: 100, introductionDismissed: true }),
    );
  });
  it('does not fail a successful export when localStorage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(() => recordWebBackup(new Date().toISOString())).not.toThrow();
  });
});
