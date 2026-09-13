import assert from 'node:assert/strict';
import test from 'node:test';
import { ApkWorkerSupervisor } from './supervisor.mjs';

function worker(options = {}) {
  return new ApkWorkerSupervisor(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import readline from 'node:readline';
    for await (const line of readline.createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      if (request.params.hang) continue;
      if (request.params.crash) process.exit(1);
      if (request.params.bad) { console.log('not json'); continue; }
      if (request.params.delay) await new Promise(resolve => setTimeout(resolve, request.params.delay));
      console.log(JSON.stringify({ id: request.id, result: { pid: process.pid, value: request.params.value } }));
    }
  `,
    ],
    { timeoutMs: 3000, idleMs: 100, ...options },
  );
}
test('reuses an idle worker, keeps order, and shuts down explicitly', async () => {
  const host = worker();
  try {
    const results = await Promise.all([host.request('list', { value: 1 }), host.request('detail', { value: 2 })]);
    assert.equal(results[0].pid, results[1].pid);
    assert.deepEqual(
      results.map((r) => r.value),
      [1, 2],
    );
  } finally {
    host.close();
  }
  await assert.rejects(host.request('describe'), /closed/);
});

test('chapter catalogs have a separate deadline from ordinary requests', async () => {
  const host = worker({ timeoutMs: 300, chaptersTimeoutMs: 3000 });
  try {
    assert.equal((await host.request('chapters', { delay: 500, value: 'catalog' })).value, 'catalog');
    await assert.rejects(host.request('list', { delay: 500 }), /timeout/);
  } finally {
    host.close();
  }
});
test('active cancellation releases the lane and queued work starts in a fresh process', async () => {
  const host = worker();
  const abort = new AbortController();
  try {
    const running = assert.rejects(host.request('list', { hang: true }, abort.signal), /cancelled/);
    const queued = host.request('list', { value: 2 });
    abort.abort();
    await running;
    assert.equal((await queued).value, 2);
  } finally {
    host.close();
  }
});
test('queued cancellation never kills the active request', async () => {
  const host = worker();
  const abort = new AbortController();
  try {
    const active = host.request('describe');
    const queued = assert.rejects(host.request('list', {}, abort.signal), /cancelled/);
    abort.abort();
    const first = await active;
    await queued;
    assert.equal((await host.request('describe')).pid, first.pid);
  } finally {
    host.close();
  }
});
test('crashes and malformed replies fail once and do not replay failed operations', async () => {
  const host = worker();
  try {
    await assert.rejects(host.request('list', { crash: true }), /exited/);
    await assert.rejects(host.request('list', { bad: true }), /response_invalid/);
    assert.equal((await host.request('list', { value: 'recovered' })).value, 'recovered');
  } finally {
    host.close();
  }
});
test('deadline and admission bounds are enforced', async () => {
  const host = worker({ timeoutMs: 300, queueLimit: 1 });
  try {
    const first = assert.rejects(host.request('list', { hang: true }), /timeout/);
    const queued = host.request('describe');
    await assert.rejects(host.request('describe'), /busy/);
    await first;
    await queued;
    await assert.rejects(host.request('invalid'), /method_invalid/);
  } finally {
    host.close();
  }
});
test('authentication page discovery has a separate bounded deadline and remains cancellable', async () => {
  const host = worker({ timeoutMs: 300, pagesTimeoutMs: 1500 });
  try {
    assert.equal((await host.request('pages', { delay: 600, value: 'ready' })).value, 'ready');
    await assert.rejects(host.request('list', { delay: 600 }), /timeout/);
    const controller = new AbortController();
    const cancelled = assert.rejects(host.request('pages', { hang: true }, controller.signal), /cancelled/);
    controller.abort();
    await cancelled;
    assert.equal((await host.request('describe', { value: 'next' })).value, 'next');
    await assert.rejects(host.request('pages', { hang: true }), /timeout/);
  } finally {
    host.close();
  }
});
