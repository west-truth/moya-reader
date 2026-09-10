import assert from 'node:assert/strict';
import { build } from 'vite';
import { chromium, devices, webkit } from 'playwright-core';
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
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${styles.map((style) => `<link rel="stylesheet" href="/${style.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
const baseUrl = `http://127.0.0.1:${await findTemporaryLoopbackPort()}`;
const scrollStabilityOnly = process.argv.includes('--scroll-stability-only');
const longCacheOnly = process.argv.includes('--long-cache-only');
const browserEngine = process.env.READER_UI_BROWSER_ENGINE || 'chromium';
const browser =
  browserEngine === 'webkit'
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ channel: process.env.READER_UI_BROWSER_CHANNEL || 'msedge', headless: true });
try {
  const profile =
    browserEngine === 'webkit' ? devices['iPad Pro 11'] : process.argv.includes('--android') ? devices['Pixel 5'] : {};
  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
    ...profile,
    serviceWorkers: 'block',
  });
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
  if (longCacheOnly) {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/reader-position?variable=1&long=1`);
    await page.waitForFunction(() => globalThis.readerFixture?.api()?.flow === 'scroll');
    await page.evaluate(() => readerFixture.api().scrollToParagraphIndex(500, 'start', 'auto'));
    await page.waitForTimeout(350);
    const original = await page.locator('[data-reader-layer="scroll"]').evaluate((root) => {
      const top = root.getBoundingClientRect().top;
      const row = [...root.querySelectorAll('[data-index]')].find(
        (row) => row.querySelector('[data-paragraph-id]') && row.getBoundingClientRect().bottom > top,
      );
      return {
        scrollTop: root.scrollTop,
        index: Number(row.dataset.index),
        height: row.getBoundingClientRect().height,
      };
    });
    await page.evaluate(() => readerFixture.api().scrollToParagraphIndex(2000, 'start', 'auto'));
    await page.waitForTimeout(350);
    const beforeReturn = await page
      .locator('.reader-virtual-list')
      .evaluate((list) => list.getBoundingClientRect().height);
    await page.evaluate((top) => {
      readerFixture.pausePages();
      document.querySelector('[data-reader-layer="scroll"]').scrollTop = top;
    }, original.scrollTop);
    await page.waitForFunction(() => document.querySelector('[data-reader-layer="scroll"] .is-loading'));
    await page.waitForTimeout(250);
    const duringReturn = await page
      .locator('.reader-virtual-list')
      .evaluate((list) => list.getBoundingClientRect().height);
    const reloaded = await page.evaluate(
      (index) =>
        document
          .querySelector(`[data-reader-layer="scroll"] [data-index="${index}"]`)
          ?.getBoundingClientRect()
          .toJSON(),
      original.index,
    );
    console.log(
      JSON.stringify({ beforeReturn, duringReturn, cachedHeight: original.height, loadingHeight: reloaded?.height }),
    );
    assert.equal(duringReturn, beforeReturn, 'Evicted text loading must not replace known paragraph heights');
    assert.equal(reloaded?.height, original.height, 'Loading row must reserve its previously measured height');
    await page.evaluate(() => readerFixture.resumePages());
    await page.waitForFunction((index) => document.querySelector(`[data-paragraph-id="p${index}"]`), original.index);
    assert.ok((await page.locator('[data-reader-layer="scroll"] [data-index]').count()) < 80);
    const requests = await page.evaluate(() => readerFixture.pageRequests);
    assert.ok(requests.length < 30, 'A long chapter must load nearby paragraph pages, not the whole chapter');
    assert.ok(
      requests.filter((index) => index === Math.floor(original.index / 120)).length >= 2,
      'The regression must revisit an evicted paragraph page',
    );
    evidence.push({
      longChapterParagraphs: 12000,
      paragraphPageRequests: requests.length,
      cachedHeightPreserved: true,
    });
    await page.close();
  }
  if (scrollStabilityOnly) {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/reader-position?variable=1`);
    await page.waitForFunction(() => globalThis.readerFixture?.api()?.flow === 'scroll');
    await page.evaluate(() => readerFixture.api().scrollToParagraphIndex(75, 'start', 'auto'));
    await page.waitForTimeout(500);
    const heightBefore = await page.locator('.reader-virtual-list').evaluate((element) => element.style.height);
    await page.evaluate(() => readerFixture.setFlow('paginated'));
    await page.waitForFunction(() => readerFixture.api()?.flow === 'paginated');
    await page.waitForTimeout(300);
    await page.evaluate(() => readerFixture.setFlow('scroll'));
    await page.waitForFunction(() => readerFixture.api()?.flow === 'scroll');
    await page.waitForTimeout(300);
    const heightAfter = await page.locator('.reader-virtual-list').evaluate((element) => element.style.height);
    assert.equal(heightAfter, heightBefore, 'A flow switch must preserve measured paragraph heights');
    const stability = await page.evaluate(async () => {
      const root = document.querySelector('[data-reader-layer="scroll"]');
      const content = root.querySelector('.reader-document');
      let motionMutations = 0;
      let transformedFrames = 0;
      const observer = new MutationObserver((records) => {
        motionMutations += records.length;
      });
      observer.observe(content, { attributes: true, attributeFilter: ['class', 'style'] });
      // Native momentum cannot be synthesized in WebKit. Exercise the app's scroll and pointer-cancel
      // path, including remounting differently sized rows above the viewport, without claiming device FPS.
      root.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch' }));
      for (let frame = 0; frame < 60; frame += 1) {
        root.scrollTop -= 35;
        await new Promise(requestAnimationFrame);
        if (getComputedStyle(content).transform !== 'none') transformedFrames += 1;
      }
      observer.disconnect();
      return { motionMutations, transformedFrames, mountedRows: root.querySelectorAll('[data-index]').length };
    });
    evidence.push({
      browserEngine,
      viewport: page.viewportSize(),
      measuredHeightPreserved: heightAfter === heightBefore,
      ...stability,
    });
    assert.equal(
      stability.motionMutations,
      0,
      'Ordinary upward scrolling must not animate or restyle the chapter body',
    );
    assert.equal(
      stability.transformedFrames,
      0,
      'Ordinary scrolling must not promote the full chapter to a transformed layer',
    );
    assert.ok(stability.mountedRows < 80, 'Scroll rows must remain bounded');
    await page.close();
  }
  for (const single of scrollStabilityOnly || longCacheOnly ? [] : [false, true]) {
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
