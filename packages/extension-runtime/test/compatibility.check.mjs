import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runExtension } from '../host.mjs';

test('only chapter catalogs accept the extended network budget', async () => {
  const source = 'globalThis.moyaExtension=async()=>true;';
  assert.equal(await runExtension({ source, method: 'source.listReleases', timeoutMs: 600000 }), true);
  assert.equal(
    await runExtension({
      source,
      method: 'invoke',
      profile: 'mangayomi-v1',
      input: { action: 'chapters' },
      timeoutMs: 600000,
    }),
    true,
  );
  await assert.rejects(runExtension({ source, method: 'source.listWorks', timeoutMs: 600000 }), {
    code: 'invalid_invocation',
  });
});

test('long external-job deadline still interrupts an infinite CPU loop', async () => {
  const started = Date.now();
  await assert.rejects(
    runExtension({ source: 'while(true){}', method: 'run', profile: 'mangayomi-v1', timeoutMs: 150000 }),
  );
  assert.ok(Date.now() - started < 10000, 'CPU must not inherit the 150-second network budget');
});

test('compatibility profile permits bounded job polling without changing ordinary broker limits', async () => {
  const input = {
    source: 'globalThis.moyaExtension=async(m,i,h)=>{for(let n=0;n<70;n++)await h.request("poll",{});return true;};',
    method: 'run',
    broker: { poll: () => null },
  };
  await assert.rejects(runExtension(input));
  assert.equal(await runExtension({ ...input, profile: 'mangayomi-v1', timeoutMs: 150000 }), true);
});
test('compatibility profile cancellation aborts pending job polling', async () => {
  const controller = new AbortController();
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = runExtension({
    source: 'globalThis.moyaExtension=async(m,i,h)=>await h.request("poll",{});',
    method: 'run',
    profile: 'mangayomi-v1',
    timeoutMs: 150000,
    signal: controller.signal,
    broker: {
      poll: (_input, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(null), { once: true });
          entered();
        }),
    },
  });
  const rejected = assert.rejects(pending, { code: 'cancelled' });
  await ready;
  controller.abort();
  await rejected;
});
