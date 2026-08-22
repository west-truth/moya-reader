import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../../../../src/repositories/reader-defaults';
import { validateSettingsBody } from './request-contracts';

describe('reader settings request contract', () => {
  it('preserves a custom application palette independently from the Reader theme', () => {
    const result = validateSettingsBody({
      ...defaultSettings,
      applicationTheme: 'custom',
      applicationThemeColors: {
        background: '#101820',
        surface: '#18242d',
        text: '#e8eef2',
        accent: '#54b7a5',
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          applicationTheme: 'custom',
          applicationThemeColors: {
            background: '#101820',
            surface: '#18242d',
            text: '#e8eef2',
            accent: '#54b7a5',
          },
        }),
      }),
    );
  });

  it('rejects invalid application colors', () => {
    expect(
      validateSettingsBody({
        ...defaultSettings,
        applicationTheme: 'custom',
        applicationThemeColors: { background: 'black' },
      }),
    ).toEqual({ ok: false, error: 'applicationThemeColors.background must be a hex color' });
  });
});
