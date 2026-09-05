import assert from 'node:assert/strict';
import { build } from 'vite';
import { chromium } from 'playwright-core';
import { findTemporaryLoopbackPort } from '../lib/temporary-loopback-port.mjs';

// Production ReaderViewport and CSS with synthetic data; no App, user storage, or provider requests.
const bundle = await build({
  configFile: false,
  logLevel: 'error',
  build: { write: false, rollupOptions: { input: 'scripts/performance/reader-position-fixture.mjs' } },
});
const output = bundle.output;
const entry = output.find((asset) => asset.type === 'chunk' && asset.isEntry);
const styles = output.filter((asset) => asset.fileName.endsWith('.css'));
const assets = new Map(output.map((asset) => [`/${asset.fileName}`, asset]));
const html = `<!doctype html><html><head>${styles.map((style) => `<link rel="stylesheet" href="/${style.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
const baseUrl = `http://127.0.0.1:${await findTemporaryLoopbackPort()}`;
const browser = await chromium.launch({ channel: process.env.READER_UI_BROWSER_CHANNEL || 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/reader-position') return route.fulfill({ contentType: 'text/html', body: html });
    const asset = assets.get(path);
    if (!asset) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({
      contentType:
        asset.type === 'chunk'
          ? 'application/javascript'
          : asset.fileName.endsWith('.css')
            ? 'text/css'
            : 'application/octet-stream',
      body: asset.type === 'chunk' ? asset.code : Buffer.from(asset.source),
    });
  });
  const evidence = [];
  const errors = [];
  for (const single of [false, true]) {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/reader-position${single ? '?single=1' : ''}`);
    await page.waitForFunction(() => globalThis.readerFixture?.api()?.flow === 'scroll');
    if (!single) await page.evaluate(() => readerFixture.api().scrollToParagraphIndex(30, 'start', 'auto'));
    await page.evaluate(() => readerFixture.setFlow('paginated'));
    await page.waitForFunction(
      () =>
        globalThis.readerFixture?.api()?.flow === 'paginated' &&
        document.querySelector('.reader-paginated-page')?.dataset.pageEndIndex !== undefined,
    );
    await page.waitForTimeout(1000);
    if (!single) await page.evaluate(() => readerFixture.api().scrollToParagraphIndex(80, 'start', 'auto'));
    await page.waitForTimeout(450);
    assert.ok(
      await page.evaluate(() => readerFixture.api().getLocation().progress < 1),
      'An early page must not finish the chapter',
    );
    await page.evaluate(() => {
      readerFixture.writes.length = 0;
      readerFixture.observations.reveals = 0;
    });
    await page.setViewportSize({ width: 600, height: 900 });
    await page.waitForTimeout(1500);
    const resized = await page.evaluate(() => ({
      visible: readerFixture.api().getLocation(),
      saved: readerFixture.writes.at(-1),
      reveals: readerFixture.observations.reveals,
    }));
    assert.equal(
      resized.saved?.paragraphIndex,
      resized.visible.paragraphIndex,
      'Hidden scroll must not replace the visible page position',
    );
    assert.equal(resized.saved?.offsetInParagraph, resized.visible.offsetInParagraph);
    assert.equal(resized.reveals, 0, 'Hidden scroll resize must not reveal chrome');
    await page.evaluate(() => readerFixture.api().scrubTo(1));
    await page.waitForTimeout(450);
    const end = await page.evaluate(() => ({
      visible: readerFixture.api().getLocation(),
      saved: readerFixture.writes.at(-1),
      anchor: readerFixture.api().getAnchor(),
    }));
    assert.equal(end.visible.progress, 1);
    assert.equal(end.saved.chapterProgress, 1);
    assert.equal(end.saved.paragraphIndex, end.anchor.blockIndex + 1);
    assert.equal(end.saved.offsetInParagraph, end.anchor.offset);
    evidence.push({
      singleParagraph: single,
      resizedVisibleParagraph: resized.visible.paragraphIndex,
      resizedSavedParagraph: resized.saved.paragraphIndex,
      finalProgress: end.saved.chapterProgress,
      finalOffset: end.saved.offsetInParagraph,
    });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ evidence, browserErrors: errors }, null, 2));
} finally {
  await browser.close();
}
