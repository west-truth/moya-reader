import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadPagesOrdered } from './ordered-page-downloads.mjs';

test('three page requests run at once, but output retains source order', async () => {
  let active = 0,
    peak = 0;
  const result = await downloadPagesOrdered([0, 1, 2, 3, 4, 5], 3, new AbortController().signal, async (page) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, (3 - (page % 3)) * 5));
    active--;
    return `page-${page}`;
  });
  assert.equal(peak, 3);
  assert.deepEqual(result, ['page-0', 'page-1', 'page-2', 'page-3', 'page-4', 'page-5']);
});
test('failure cancels siblings, stops admission and waits for their cleanup', async () => {
  const started = [],
    cleaned = [];
  await assert.rejects(
    downloadPagesOrdered([0, 1, 2, 3, 4], 3, new AbortController().signal, async (page, signal) => {
      started.push(page);
      if (page === 1) throw new Error('source_body_limit');
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', resolve, { once: true });
      });
      cleaned.push(page);
      signal.throwIfAborted();
    }),
    /source_body_limit/,
  );
  assert.deepEqual(started, [0, 1, 2]);
  assert.deepEqual(cleaned.sort(), [0, 2]);
});
test('caller cancellation prevents any requests', async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(downloadPagesOrdered([1, 2], 3, abort.signal, async () => assert.fail('unexpected request')));
});
