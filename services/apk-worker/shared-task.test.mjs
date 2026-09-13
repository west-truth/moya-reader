import test from 'node:test';
import assert from 'node:assert/strict';
import { joinTask } from './shared-task.mjs';

test('one cancelled reader does not cancel a shared chapter fill; all cancellations release the worker', async () => {
  const pending = new Map();
  const a = new AbortController();
  const b = new AbortController();
  let finish;
  let sharedSignal;
  let calls = 0;
  const task = (signal) => {
    calls++;
    sharedSignal = signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const first = joinTask(pending, 'work', a.signal, task);
  const rejected = assert.rejects(first);
  const second = joinTask(pending, 'work', b.signal, task);
  await Promise.resolve();
  a.abort();
  await rejected;
  assert.equal(sharedSignal.aborted, false);
  assert.equal(calls, 1);
  finish('chapters');
  assert.equal(await second, 'chapters');
  const c = new AbortController();
  const third = joinTask(pending, 'next', c.signal, task);
  const cancelled = assert.rejects(third);
  await Promise.resolve();
  c.abort();
  await cancelled;
  assert.equal(sharedSignal.aborted, true);
  finish('discarded');
});
