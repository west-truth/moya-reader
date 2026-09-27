import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageRequestQueue } from './image-request-queue.mjs';
const tick = () => new Promise((resolve) => setImmediate(resolve));
test('reserves a read slot, promotes a shared queued page and bounds concurrency', async () => {
  const queue = new ImageRequestQueue(),
    started = [],
    finish = new Map();
  const signal = new AbortController().signal;
  let active = 0,
    max = 0;
  const run = (id, foreground) =>
    queue.run(id, foreground, signal, async () => {
      started.push(id);
      max = Math.max(max, ++active);
      await new Promise((resolve) => finish.set(id, resolve));
      active--;
    });
  const jobs = [run('save1', false), run('save2', false), run('shared', false), run('save4', false)];
  await tick();
  assert.deepEqual(started, ['save1', 'save2']);
  queue.promote('shared');
  await tick();
  assert.deepEqual(started, ['save1', 'save2', 'shared']);
  jobs.push(run('read', true));
  finish.get('save1')();
  await tick();
  assert.equal(started.at(-1), 'read');
  finish.get('read')();
  finish.get('save2')();
  finish.get('shared')();
  await tick();
  finish.get('save4')();
  await Promise.all(jobs);
  assert.equal(max, 3);
});
test('cancelled queued pages never request the upstream and rejection releases a slot', async () => {
  const queue = new ImageRequestQueue(),
    signal = new AbortController().signal;
  let release;
  const pending = new Promise((resolve) => (release = resolve));
  const jobs = [queue.run('a', false, signal, () => pending), queue.run('b', false, signal, () => pending)];
  const abort = new AbortController();
  let called = false;
  const cancelled = queue.run('c', false, abort.signal, () => {
    called = true;
  });
  abort.abort(new Error('cancelled'));
  await assert.rejects(cancelled, /cancelled/);
  await assert.rejects(
    queue.run('bad', true, signal, () => {
      throw new Error('network');
    }),
    /network/,
  );
  assert.equal(await queue.run('read', true, signal, () => 'ok'), 'ok');
  release();
  await Promise.all(jobs);
  assert.equal(called, false);
});
