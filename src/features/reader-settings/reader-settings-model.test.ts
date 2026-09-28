import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import { readerSettingsEqual } from './reader-settings-model';

describe('readerSettingsEqual', () => {
  it('treats a missing source progress basis as the source default and notices a real change', () => {
    expect(readerSettingsEqual(defaultSettings, { ...defaultSettings, sourceProgressBasis: 'source' })).toBe(true);
    expect(readerSettingsEqual(defaultSettings, { ...defaultSettings, sourceProgressBasis: 'downloaded' })).toBe(false);
  });
});
