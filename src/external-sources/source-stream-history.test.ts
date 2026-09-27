import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSourceStreamPosition, saveSourceStreamPosition } from './source-stream-history';
afterEach(() => vi.unstubAllGlobals());
function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  return values;
}
describe('streaming reading history', () => {
  it('isolates account/source identities, retains page offset and caps the metadata history', () => {
    storage();
    const position = { page: 4, count: 30, fraction: 0.45, ratio: 6 };
    saveSourceStreamPosition('account-a:episode', position);
    expect(readSourceStreamPosition('account-b:episode')).toBeUndefined();
    expect(readSourceStreamPosition('account-a:episode')).toMatchObject(position);
    for (let i = 0; i < 200; i++) saveSourceStreamPosition(String(i), position);
    expect(readSourceStreamPosition('account-a:episode')).toBeUndefined();
    expect(readSourceStreamPosition('199')).toMatchObject(position);
  });
  it('ignores corrupted records and tolerates unavailable browser storage', () => {
    const values = storage();
    values.set('moya.source-stream-positions.v1', JSON.stringify([['bad', { page: 2, count: 1, fraction: 0 }]]));
    expect(readSourceStreamPosition('bad')).toBeUndefined();
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('full');
      },
    });
    expect(() => saveSourceStreamPosition('a', { page: 0, count: 1, fraction: 0, ratio: 1 })).not.toThrow();
    expect(readSourceStreamPosition('a')).toBeUndefined();
  });
});
