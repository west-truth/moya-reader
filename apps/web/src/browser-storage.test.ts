import { describe, expect, it, vi } from 'vitest';
import { readBrowserStorage, requestBrowserPersistence } from './browser-storage';

describe('browser-owned storage', () => {
  it('degrades without a storage management API', async () => {
    expect(await readBrowserStorage({} as StorageManager)).toEqual({
      canRequestPersistence: false,
      usage: undefined,
      quota: undefined,
      persistent: undefined,
    });
    expect(await requestBrowserPersistence({} as StorageManager)).toBeUndefined();
  });
  it('does not request persistence as a side effect of reading usage', async () => {
    const persist = vi.fn(async () => false);
    const storage = {
      estimate: async () => ({ usage: 10, quota: 100 }),
      persisted: async () => false,
      persist,
    } as unknown as StorageManager;
    expect(await readBrowserStorage(storage)).toEqual({
      usage: 10,
      quota: 100,
      persistent: false,
      canRequestPersistence: true,
    });
    expect(persist).not.toHaveBeenCalled();
    expect(await requestBrowserPersistence(storage)).toBe(false);
  });
  it('propagates storage rejection so the UI can report failure without deleting data', async () => {
    await expect(
      readBrowserStorage({
        estimate: async () => {
          throw new Error('denied');
        },
      } as unknown as StorageManager),
    ).rejects.toThrow('denied');
  });
});
