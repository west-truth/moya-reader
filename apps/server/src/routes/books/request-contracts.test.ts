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

  it('preserves versioned global and per-book AI workflow preferences', () => {
    const result = validateSettingsBody({
      ...defaultSettings,
      aiWorkflows: {
        schemaVersion: 1,
        defaultWorkflowId: 'moya.ai.analysis.character-bundle',
        bookOverrides: { book_1: 'example.ai.alternate-workflow' },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          aiWorkflows: {
            schemaVersion: 1,
            defaultWorkflowId: 'moya.ai.analysis.character-bundle',
            bookOverrides: { book_1: 'example.ai.alternate-workflow' },
          },
        }),
      }),
    );
  });

  it('rejects malformed AI workflow preferences', () => {
    expect(
      validateSettingsBody({
        ...defaultSettings,
        aiWorkflows: {
          schemaVersion: 1,
          defaultWorkflowId: 'not-namespaced',
        },
      }),
    ).toEqual({ ok: false, error: 'aiWorkflows.defaultWorkflowId is invalid' });
  });
});
