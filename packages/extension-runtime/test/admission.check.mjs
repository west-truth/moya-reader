import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExtensionAdmission } from '../admission.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('bounded FIFO admission refuses overflow and starts queued work after a slot is released', async () => {
  const admission = new ExtensionAdmission({ concurrency: 1, queueLimit: 1 });
  const gate = deferred();
  const order = [];
  const first = admission.run(async () => {
    order.push(1);
    await gate.promise;
  });
  const second = admission.run(async () => {
    order.push(2);
    return 2;
  });
  await assert.rejects(
    admission.run(async () => 3),
    /execution_busy/,
  );
  assert.deepEqual(order, [1]);
  gate.resolve();
  await first;
  assert.equal(await second, 2);
  assert.deepEqual(order, [1, 2]);
});

test('queued cancellation never starts and running cancellation cannot overbook a cleanup slot', async () => {
  const admission = new ExtensionAdmission({ concurrency: 1, queueLimit: 1 });
  const gate = deferred();
  const running = new AbortController();
  const queued = new AbortController();
  let starts = 0;
  const first = admission.run(() => gate.promise, running.signal);
  const second = admission.run(async () => {
    starts++;
  }, queued.signal);
  queued.abort();
  await assert.rejects(second, /cancelled/);
  running.abort();
  await assert.rejects(first, /cancelled/);
  const third = admission.run(async () => {
    starts++;
  });
  await Promise.resolve();
  assert.equal(starts, 0);
  gate.resolve();
  await third;
  assert.equal(starts, 1);
});

test('wait deadline clears admission and a task rejection does not poison later executions', async () => {
  const admission = new ExtensionAdmission({ concurrency: 1, queueLimit: 1, waitMs: 10 });
  const gate = deferred();
  const first = admission.run(() => gate.promise);
  await assert.rejects(
    admission.run(async () => {}),
    /execution_busy/,
  );
  gate.resolve();
  await first;
  await assert.rejects(
    admission.run(async () => {
      throw new Error('failure');
    }),
    /failure/,
  );
  assert.equal(await admission.run(async () => 'ok'), 'ok');
});
