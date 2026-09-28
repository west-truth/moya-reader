import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import { readerSettingsEqual } from './reader-settings-model';

describe('readerSettingsEqual', () => {
  it('detects startup destination changes including a shelf or tab within the same screen', () => {
    const settings = { ...defaultSettings, startupScreen: { kind: 'library' as const, shelfId: 'normal' } };
    expect(readerSettingsEqual(settings, structuredClone(settings))).toBe(true);
    expect(readerSettingsEqual(settings, { ...settings, startupScreen: { kind: 'library' } })).toBe(false);
    expect(readerSettingsEqual(settings, { ...settings, startupScreen: undefined })).toBe(false);
  });
  it('treats a missing source progress basis as the source default and notices a real change', () => {
    expect(readerSettingsEqual(defaultSettings, { ...defaultSettings, sourceProgressBasis: 'source' })).toBe(true);
    expect(readerSettingsEqual(defaultSettings, { ...defaultSettings, sourceProgressBasis: 'downloaded' })).toBe(false);
  });
});
