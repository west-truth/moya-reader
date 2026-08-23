import { describe, expect, it } from 'vitest';
import { resolveReaderThemeColors } from './reader-theme-colors';

describe('Reader theme colors', () => {
  it('keeps preset Reader colors independent from application chrome', () => {
    expect(resolveReaderThemeColors({ theme: 'light' })).toEqual({
      foreground: '#35383d',
      background: '#f8f7f3',
    });
    expect(resolveReaderThemeColors({ theme: 'midnight' })).toEqual({
      foreground: '#d9e0ea',
      background: '#080f19',
    });
  });

  it('uses explicit custom colors with a readable fallback', () => {
    expect(resolveReaderThemeColors({ theme: 'custom', foreground: '#f0e0d0', background: '#201810' })).toEqual({
      foreground: '#f0e0d0',
      background: '#201810',
    });
    expect(resolveReaderThemeColors({ theme: 'custom' })).toEqual({
      foreground: '#eeeeea',
      background: '#181817',
    });
  });
});
