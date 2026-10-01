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
it('defaults to five images each way and retains explicit existing prefetch choices', () => {
  storage();
  expect(sourceReadingPreferences().prefetch).toBe(5);
  for (const prefetch of [0, 2, 4, 5, 8, 10] as const) {
    storage(JSON.stringify({ mode: 'stream-save', prefetch }));
    expect(sourceReadingPreferences()).toMatchObject({ mode: 'stream-save', prefetch });
    saveSourceReadingPreferences({ coverHours: 24 });
    expect(sourceReadingPreferences().prefetch).toBe(prefetch);
  }
  storage('{"prefetch":999}');
  expect(sourceReadingPreferences().prefetch).toBe(5);
});
