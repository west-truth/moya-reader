import { describe, expect, it } from 'vitest';
import { appThemeColor, normalizeApplicationThemeColors, resolveAppTheme } from './app-theme';

describe('application theme projection', () => {
  it('keeps preset and custom application themes intact', () => {
    expect(resolveAppTheme('light')).toBe('light');
    expect(resolveAppTheme('dark')).toBe('dark');
    expect(resolveAppTheme('sepia')).toBe('sepia');
    expect(resolveAppTheme('midnight')).toBe('midnight');
    expect(resolveAppTheme('custom')).toBe('custom');
  });

  it('provides matching browser chrome colors', () => {
    expect(appThemeColor('light')).toBe('#f8f7f3');
    expect(appThemeColor('dark')).toBe('#111416');
    expect(appThemeColor('midnight')).toBe('#09111b');
    expect(appThemeColor('custom', { background: '#102030' })).toBe('#102030');
  });

  it('normalizes incomplete custom palettes without accepting unsafe color values', () => {
    expect(normalizeApplicationThemeColors({ background: '#abcdef', text: 'red' })).toEqual({
      background: '#abcdef',
      surface: '#1b1e22',
      text: '#e2e5e8',
      accent: '#4c7df0',
    });
  });
});
