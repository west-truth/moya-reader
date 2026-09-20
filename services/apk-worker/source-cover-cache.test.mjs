import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceCoverCache } from './source-cover-cache.mjs';
const signal = () => new AbortController().signal;
const image = (size = 4) => ({ blob: new Blob([new Uint8Array(size)]), sha256: 'test' });

test('covers expire and evict by bytes and LRU; oversized images are not retained', async () => {
  let now = 0,
    calls = 0;
  const cache = new SourceCoverCache({ maxBytes: 8, maxEntries: 2, ttl: 10, now: () => now });
  const load = async () => {
    calls++;
    return image();
  };
  await cache.resolve('a', signal(), load);
  await cache.resolve('b', signal(), load);
  await cache.resolve('a', signal(), load);
  await cache.resolve('c', signal(), load);
  assert.equal(calls, 3);
  await cache.resolve('b', signal(), load);
  assert.equal(calls, 4);
  now = 11;
  await cache.resolve('b', signal(), load);
  assert.equal(calls, 5);
  let oversized = 0;
  const large = async () => {
    oversized++;
    return image(9);
  };
  await cache.resolve('large', signal(), large);
  await cache.resolve('large', signal(), large);
  assert.equal(oversized, 2);
});

test('shared cover requests survive one reader leaving and remain isolated between catalogs', async () => {
  const cache = new SourceCoverCache();
  const first = new AbortController();
  let finish,
    sharedSignal,
    calls = 0;
  const load = async (s) => {
    calls++;
    sharedSignal = s;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const a = cache.resolve('cover', first.signal, load);
  const rejected = assert.rejects(a, /cancel/);
  const b = cache.resolve('cover', signal(), load);
  await Promise.resolve();
  first.abort(new Error('cancel'));
  await rejected;
  assert.equal(sharedSignal.aborted, false);
  finish(image());
  const value = await b;
  assert.equal(await cache.resolve('cover', signal(), load), value);
  assert.equal(calls, 1);
  const other = new SourceCoverCache();
  assert.notEqual(await other.resolve('cover', signal(), async () => image()), value);
});

test('errors and fills completed after close are never cached', async () => {
  const cache = new SourceCoverCache();
  await assert.rejects(
    cache.resolve('cover', signal(), async () => {
      throw new Error('network');
    }),
    /network/,
  );
  let finish;
  const pending = cache.resolve(
    'cover',
    signal(),
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const rejected = assert.rejects(pending, /abort/i);
  await Promise.resolve();
  cache.clear();
  finish(image());
  await rejected;
  let calls = 0;
  await cache.resolve('cover', signal(), async () => {
    calls++;
    return image();
  });
  assert.equal(calls, 1);
});

test('transient failures retain expired covers within the retention limit, but authentication failures do not', async () => {
  let now = 0;
  const cache = new SourceCoverCache({ ttl: 10, keep: 100, now: () => now });
  const first = await cache.resolve('cover', signal(), async () => image());
  now = 11;
  const failed = async () => {
    throw new Error('HTTP 502');
  };
  assert.equal(await cache.resolve('cover', signal(), failed), first);
  await assert.rejects(
    cache.resolve('cover', signal(), async () => {
      throw new Error('HTTP 403');
    }),
    /403/,
  );
  now = 101;
  await assert.rejects(cache.resolve('cover', signal(), failed), /502/);
  cache.clear();
});
