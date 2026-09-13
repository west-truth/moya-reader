import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runExtension } from '../host.mjs';

const source = (expression) => `globalThis.moyaExtension = async (method, input, host) => (${expression});`;

test('isolated realm has no browser, Node, filesystem or network authority', async () => {
  const value = await runExtension({
    source: source(
      '[typeof process, typeof require, typeof fetch, typeof window, typeof indexedDB, typeof WebAssembly]',
    ),
    method: 'probe',
  });
  assert.deepEqual(value, Array(6).fill('undefined'));
});

test('only explicitly granted JSON brokers are reachable', async () => {
  const value = await runExtension({
    source: source('await host.request("catalog", input)'),
    method: 'list',
    input: { query: '작품' },
    broker: {
      catalog: (input) => ({ title: input.query, order: [1, 2] }),
    },
  });
  assert.deepEqual(value, { title: '작품', order: [1, 2] });
  await assert.rejects(runExtension({ source: source('await host.request("constructor", null)'), method: 'list' }), {
    code: 'permission_denied',
  });
});

test('guest exceptions do not expose source text or stack traces', async () => {
  await assert.rejects(runExtension({ source: 'throw new Error("private-source-text")', method: 'list' }), (error) => {
    assert.equal(error.code, 'execution_failed');
    assert.doesNotMatch(error.stack, /private-source-text/);
    return true;
  });
});

test('interrupts synchronous loops and promise microtask loops', async () => {
  for (const code of [
    'while(true) {}',
    'globalThis.moyaExtension = async () => { while(true) await Promise.resolve(); }',
  ]) {
    const start = Date.now();
    await assert.rejects(runExtension({ source: code, method: 'list', timeoutMs: 100 }), { code: 'execution_timeout' });
    assert.ok(Date.now() - start < 2500);
  }
  assert.equal(await runExtension({ source: source('42'), method: 'list' }), 42);
});

test('allocation explosion is contained and a subsequent invocation still works', async () => {
  await assert.rejects(
    runExtension({
      source: 'const a=[]; while(true) a.push(new Array(10000).fill("x"));',
      method: 'list',
      memoryBytes: 4 * 1024 * 1024,
    }),
    { code: 'execution_failed' },
  );
  assert.equal(await runExtension({ source: source('"ok"'), method: 'list' }), 'ok');
});

test('abort reaches pending broker and rejects without waiting for its response', async () => {
  const controller = new AbortController();
  let aborted;
  const started = new Promise((resolve) => {
    aborted = resolve;
  });
  const promise = runExtension({
    source: source('await host.request("wait", null)'),
    method: 'list',
    signal: controller.signal,
    broker: {
      wait: (_, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted();
              resolve('late');
            },
            { once: true },
          );
          controller.abort();
        }),
    },
  });
  await assert.rejects(promise, { code: 'cancelled' });
  await started;
});

test('realms do not share mutable state and result size is bounded', async () => {
  assert.equal(
    await runExtension({ source: 'globalThis.secret = 123; globalThis.moyaExtension=()=>true;', method: 'list' }),
    true,
  );
  assert.equal(await runExtension({ source: source('typeof secret'), method: 'list' }), 'undefined');
  await assert.rejects(runExtension({ source: source('"a".repeat(1100000)'), method: 'list' }), {
    code: 'payload_limit',
  });
});

test('imports and prototype-chain host method lookup cannot grant authority', async () => {
  await assert.rejects(runExtension({ source: source('await import("node:fs")'), method: 'list' }), {
    code: 'execution_failed',
  });
  await assert.rejects(runExtension({ source: source('await host.request("toString", null)'), method: 'list' }), {
    code: 'permission_denied',
  });
});
