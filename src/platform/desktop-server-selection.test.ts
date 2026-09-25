import { describe, expect, it } from 'vitest';
import {
  DESKTOP_SERVER_SELECTION_KEY,
  normalizeDesktopServerUrl,
  readDesktopServerSelection,
  saveDesktopServerSelection,
} from './desktop-server-selection';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe('desktop server selection', () => {
  it('keeps existing installations on the embedded server', () => {
    expect(readDesktopServerSelection(memoryStorage())).toEqual({ version: 1, mode: 'embedded' });
  });

  it('stores only a normalized server origin', () => {
    const storage = memoryStorage();
    saveDesktopServerSelection(storage, { version: 1, mode: 'remote', serverUrl: ' https://reader.example:8443 ' });
    expect(readDesktopServerSelection(storage)).toEqual({
      version: 1,
      mode: 'remote',
      serverUrl: 'https://reader.example:8443/',
    });
    expect(storage.getItem(DESKTOP_SERVER_SELECTION_KEY)).not.toContain('password');
  });

  it.each([
    'file:///tmp/reader.html',
    'https://user:pass@reader.example/',
    'https://reader.example/api',
    'https://reader.example/?token=secret',
    'https://reader.example/#fragment',
  ])('rejects a URL that is not a server home page: %s', (value) => {
    expect(() => normalizeDesktopServerUrl(value)).toThrow();
  });

  it('does not silently switch to an empty embedded library when saved remote settings are damaged', () => {
    const storage = memoryStorage();
    storage.setItem(DESKTOP_SERVER_SELECTION_KEY, '{broken');
    expect(() => readDesktopServerSelection(storage)).toThrow('저장된 서재 선택');
  });
});
