import { afterEach, expect, it, vi } from 'vitest';
import { saveSourceReadingPreferences, sourceReadingPreferences } from './source-reading-preferences';
afterEach(() => vi.unstubAllGlobals());
function storage(initial?: string) {
  let value = initial ?? null;
  vi.stubGlobal('localStorage', {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
}
it.each([undefined, '{}', '{"mode":"invalid"}', 'broken'])('defaults to streaming without a download (%s)', (input) => {
  storage(input);
  expect(sourceReadingPreferences().mode).toBe('stream');
});
it.each(['stream-save', 'download', 'stream'] as const)(
  'retains the saved %s choice when other settings change',
  (mode) => {
    storage(JSON.stringify({ mode }));
    expect(sourceReadingPreferences().mode).toBe(mode);
    saveSourceReadingPreferences({ prefetch: 2 });
    expect(sourceReadingPreferences()).toMatchObject({ mode, prefetch: 2 });
  },
);
it('keeps streaming as the default when only cache options are saved', () => {
  storage();
  saveSourceReadingPreferences({ coverHours: 1 });
  expect(sourceReadingPreferences()).toMatchObject({ mode: 'stream', coverHours: 1 });
});
