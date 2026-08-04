import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertLocalImportCapacity, estimatedLocalImportBytes } from './browser-import-service';

describe('browser import storage preflight', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('allows import when the browser reports enough persistent storage', async () => {
    vi.stubGlobal('navigator', {
      storage: { estimate: vi.fn(async () => ({ quota: 100 * 1024 * 1024, usage: 10 * 1024 * 1024 })) },
    });
    await expect(assertLocalImportCapacity(20 * 1024 * 1024)).resolves.toBeUndefined();
    expect(estimatedLocalImportBytes(20 * 1024 * 1024)).toBe(68 * 1024 * 1024);
  });

  it('stops before worker parsing when estimated storage is insufficient', async () => {
    vi.stubGlobal('navigator', {
      storage: { estimate: vi.fn(async () => ({ quota: 24 * 1024 * 1024, usage: 20 * 1024 * 1024 })) },
    });
    await expect(assertLocalImportCapacity(2 * 1024 * 1024)).rejects.toThrow('저장공간이 부족합니다');
  });

  it('keeps the existing import path when StorageManager is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    await expect(assertLocalImportCapacity(20 * 1024 * 1024)).resolves.toBeUndefined();
  });
});
