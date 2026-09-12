import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'vite';
import { chromium, devices, webkit } from 'playwright-core';

// Source positions and decoded illustrations, not just scrollTop. Synthetic touch
// ordering covers the application race; physical Safari/Chrome inertia is separate.
const bundle = await build({
  configFile: false,
  logLevel: 'error',
  build: { write: false, rollupOptions: { input: 'scripts/performance/reader-position-fixture.mjs' } },
});
const output = bundle.output;
const entry = output.find((asset) => asset.isEntry);
const styles = output.filter((asset) => asset.fileName.endsWith('.css'));
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map((asset) => `<link rel="stylesheet" href="/${asset.fileName}">`).join('')}<div id="root"></div><script type="module" src="/${entry.fileName}"></script>`;
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const asset = output.find((item) => `/${item.fileName}` === path);
  response.writeHead(path === '/reader' || asset ? 200 : 404, {
    'content-type': path === '/reader' ? 'text/html' : asset?.type === 'chunk' ? 'application/javascript' : 'text/css',
  });
  response.end(path === '/reader' ? html : (asset?.code ?? asset?.source ?? ''));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/reader`;
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const browser = await (engine === 'webkit'
  ? webkit.launch({ headless: true })
  : chromium.launch({ channel: 'msedge', headless: true }));
try {
  const context = await browser.newContext({
    ...devices[engine === 'webkit' ? 'iPad Pro 11' : 'Pixel 5'],
    serviceWorkers: 'block',
  });
  const errors = [];
  const open = async () => {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${baseUrl}?long&variable&resume=9000&pause`);
    await page.waitForFunction(() => readerFixture.pageRequests.includes(75));
    return page;
  };
  const page = await open();
  const pending = await page.evaluate(async () => {
    const root = document.querySelector('[data-reader-layer="scroll"]');
    const touch = new Event('touchstart', { bubbles: true });
    Object.defineProperty(touch, 'touches', { value: [{ clientY: 300 }] });
    root.dispatchEvent(touch);
    root.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true }));
    await readerFixture.api().flushPosition();
    return {
      inert: root.inert,
      busy: root.getAttribute('aria-busy'),
      visibility: getComputedStyle(root.querySelector('article')).visibility,
      writes: readerFixture.writes,
    };
  });
  assert.equal(pending.busy, 'true', 'Resume must be pending before the first source is exposed');
  assert.equal(pending.inert, true, 'Early touch/keyboard input cannot replace the resume target');
  assert.equal(pending.visibility, 'hidden', 'Do not show chapter start while restoring');
  assert.deepEqual(pending.writes, [], 'Flush while restoring must preserve the saved position');
  if (process.argv.includes('--screenshots'))
    await page.screenshot({ path: `.tmp/reader-resume-loading-${engine}.png` });
  await page.evaluate(() => {
    globalThis.resumeFrames = [];
    const sample = () => {
      const root = document.querySelector('[data-reader-layer="scroll"]');
      if (root.getAttribute('aria-busy') !== 'true') resumeFrames.push(readerFixture.api().getAnchor()?.blockIndex);
      if (resumeFrames.length < 12) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    readerFixture.resumePages();
  });
  await page.waitForFunction(
    () => document.querySelector('[data-reader-layer="scroll"]').getAttribute('aria-busy') !== 'true',
  );
  const restored = await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await readerFixture.api().flushPosition();
    return { anchor: readerFixture.api().getAnchor(), writes: readerFixture.writes };
  });
  assert.equal(restored.anchor.blockIndex, 9000, 'First readable screen must be the saved paragraph');
  if (process.argv.includes('--screenshots')) await page.screenshot({ path: `.tmp/reader-resume-ready-${engine}.png` });
  assert.ok(restored.writes.length > 0);
  assert.ok(
    restored.writes.every((write) => write.paragraphIndex === 9001),
    `Persist the restored source, not padding/overscan: ${restored.writes.map((write) => write.paragraphIndex)}`,
  );
  await page.waitForFunction(() => resumeFrames.length === 12);
  assert.deepEqual(
    await page.evaluate(() => resumeFrames),
    Array(12).fill(9000),
    'First readable frames stay at the saved source',
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(() => readerFixture.restore(readerFixture.writes.at(-1).paragraphIndex - 1));
    await page.waitForFunction(
      () => document.querySelector('[data-reader-layer="scroll"]').getAttribute('aria-busy') === 'true',
    );
    await page.waitForFunction(
      () => document.querySelector('[data-reader-layer="scroll"]').getAttribute('aria-busy') !== 'true',
    );
    await page.evaluate(() => readerFixture.api().flushPosition());
    assert.equal(
      await page.evaluate(() => readerFixture.writes.at(-1).paragraphIndex),
      9001,
      'Repeated resume must not drift backward',
    );
  }
  await page.close();

  const failed = await open();
  await failed.evaluate(() => {
    readerFixture.failPages(true);
    readerFixture.resumePages();
  });
  await failed.getByRole('button', { name: '다시 시도', exact: true }).waitFor();
  await failed.evaluate(() => readerFixture.api().flushPosition());
  assert.deepEqual(await failed.evaluate(() => readerFixture.writes), [], 'Failure must not save start');
  await failed.evaluate(() => readerFixture.failPages(false));
  await failed.getByRole('button', { name: '다시 시도', exact: true }).click();
  await failed.waitForFunction(
    () => document.querySelector('[data-reader-layer="scroll"]').getAttribute('aria-busy') !== 'true',
  );
  assert.equal(await failed.evaluate(() => readerFixture.api().getAnchor().blockIndex), 9000);
  await failed.close();

  const abandoned = await open();
  await abandoned.evaluate(async () => {
    await readerFixture.api().flushPosition();
    readerFixture.setMounted(false);
  });
  await abandoned.waitForFunction(() => !document.querySelector('[data-reader-layer="scroll"]'));
  await abandoned.evaluate(() => readerFixture.resumePages());
  await abandoned.waitForTimeout(450);
  assert.deepEqual(
    await abandoned.evaluate(() => readerFixture.writes),
    [],
    'Leaving during resume must keep old position',
  );
  await abandoned.close();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      engine,
      restoredIndex: restored.anchor.blockIndex,
      scenarios: ['delayed-resume-input-flush', 'failure-retry', 'leave-during-resume'],
    }),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
