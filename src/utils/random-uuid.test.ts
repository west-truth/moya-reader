import { afterEach, expect, it, vi } from 'vitest';
import { randomUuid } from './random-uuid';
afterEach(() => vi.unstubAllGlobals());
it('generates RFC 4122 version 4 ids when HTTP hides crypto.randomUUID', () => {
  const values = vi.fn((bytes: Uint8Array) => bytes.fill(255));
  vi.stubGlobal('crypto', { getRandomValues: values });
  expect(randomUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  expect(values).toHaveBeenCalledOnce();
});
