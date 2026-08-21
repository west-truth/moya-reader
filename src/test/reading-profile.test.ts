import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../repositories/reader-defaults';
import {
  readingProfileContrastWarning,
  resolveReadingProfile,
  settingsWithResolvedReadingProfile,
  updateBookReadingProfile,
  updateGlobalReadingProfile,
} from '../features/reader-settings/reading-profile';

describe('reading profile', () => {
  it('migrates legacy settings and keeps sparse book overrides isolated', () => {
    const global = updateGlobalReadingProfile(defaultSettings, { fontSize: 20, lineHeight: 2 });
    const withBook = updateBookReadingProfile(global, 'book_1', { fontSize: 16, textAlign: 'justify' });
    expect(resolveReadingProfile(withBook, 'book_1')).toMatchObject({
      fontSize: 16,
      lineHeight: 2,
      textAlign: 'justify',
    });
    expect(resolveReadingProfile(withBook, 'book_2')).toMatchObject({
      fontSize: 20,
      lineHeight: 2,
      textAlign: 'start',
    });
  });

  it('warns only for low-contrast custom colors', () => {
    const lowContrast = resolveReadingProfile(
      updateGlobalReadingProfile(defaultSettings, {
        theme: 'custom',
        foreground: '#777777',
        background: '#787878',
      }),
    );
    expect(readingProfileContrastWarning(lowContrast)).toBe(true);
    expect(readingProfileContrastWarning({ ...lowContrast, foreground: '#ffffff', background: '#111111' })).toBe(false);
  });

  it('migrates old flows into automatic mode and preserves their page motion', () => {
    expect(
      resolveReadingProfile({
        ...defaultSettings,
        readingProfile: { ...defaultSettings.readingProfile, flow: 'screen_turn' },
      }),
    ).toMatchObject({
      flow: 'scroll',
      modeLock: 'auto',
      pageTurnMotion: 'smooth',
    });
    const legacyPaginated = {
      ...defaultSettings,
      readingProfile: { ...defaultSettings.readingProfile, flow: 'paginated', pageTurnMotion: undefined },
    } as unknown as typeof defaultSettings;
    expect(resolveReadingProfile(legacyPaginated)).toMatchObject({
      flow: 'scroll',
      modeLock: 'auto',
      pageTurnMotion: 'instant',
    });
  });

  it('persists explicit scroll and page locks independently from automatic mode', () => {
    expect(resolveReadingProfile(updateGlobalReadingProfile(defaultSettings, { modeLock: 'scroll' }))).toMatchObject({
      modeLock: 'scroll',
      flow: 'scroll',
    });
    expect(resolveReadingProfile(updateGlobalReadingProfile(defaultSettings, { modeLock: 'paginated' }))).toMatchObject(
      { modeLock: 'paginated', flow: 'paginated' },
    );

    const bookLocked = updateBookReadingProfile(defaultSettings, 'book_1', { modeLock: 'paginated' });
    expect(settingsWithResolvedReadingProfile(bookLocked, 'book_1')).toMatchObject({
      flow: 'page',
      readingProfile: { modeLock: 'paginated', flow: 'paginated' },
    });
  });
});
