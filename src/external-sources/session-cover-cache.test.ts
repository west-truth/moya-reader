import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionCoverCache } from './session-cover-cache';
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('SessionCoverCache', () => {
  it('keeps a shared download alive when one consumer leaves and reuses its URL', async () => {
    const create = vi.fn(() => 'blob:cover');
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    let finish!: (blob: Blob) => void;
    const load = vi.fn(
      () =>
        new Promise<Blob>((resolve) => {
          finish = resolve;
        }),
    );
    const cache = new SessionCoverCache();
    const first = new AbortController();
    const a = cache.resolve('one', load, first.signal);
    const b = cache.resolve('one', load, new AbortController().signal);
    first.abort();
    await expect(a).rejects.toBeDefined();
    finish(new Blob(['image'], { type: 'image/png' }));
    expect(await b).toBe('blob:cover');
    expect(await cache.resolve('one', load, new AbortController().signal)).toBe('blob:cover');
    expect(load).toHaveBeenCalledTimes(1);
    cache.clear();
    expect(revoke).toHaveBeenCalledWith('blob:cover');
  });
  it('does not revoke displayed images when the cache reaches its entry limit', async () => {
    let id = 0;
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => `blob:${++id}`, revokeObjectURL: revoke });
    const cache = new SessionCoverCache();
    const load = async () => new Blob(['image'], { type: 'image/png' });
    const signal = new AbortController().signal;
    const first = await cache.resolve('0', load, signal);
    vi.stubGlobal('document', { images: [{ src: first }] });
    for (let i = 1; i <= 200; i++) await cache.resolve(String(i), load, signal);
    expect(revoke).not.toHaveBeenCalledWith(first);
    expect(revoke).toHaveBeenCalledWith('blob:2');
    cache.clear();
  });
  it('rejects stale in-flight data after clear without publishing an object URL', async () => {
    const create = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: vi.fn() });
    const cache = new SessionCoverCache();
    let finish!: (blob: Blob) => void;
    const pending = cache.resolve(
      'one',
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      new AbortController().signal,
    );
    cache.clear();
    finish(new Blob(['image'], { type: 'image/png' }));
    await expect(pending).rejects.toBeDefined();
    expect(create).not.toHaveBeenCalled();
  });
});
