import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'vite';
import { chromium, webkit } from 'playwright-core';

// Source positions and decoded illustrations, not just scrollTop. Synthetic touch
// ordering covers the application race; physical Safari/Chrome inertia is separate.
const bundle = await build({
  configFile: false,
  logLevel: 'error',
  build: { write: false, rollupOptions: { input: 'scripts/performance/auto-scroll-fixture.mjs' } },
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
  : chromium.launch({
      ...(process.env.READER_UI_BROWSER_EXECUTABLE
        ? { executablePath: process.env.READER_UI_BROWSER_EXECUTABLE }
        : { channel: process.env.READER_UI_BROWSER_CHANNEL ?? 'msedge' }),
      headless: true,
    }));
try {
  for (const width of [320, 834]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: true });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (process.argv.includes('--paginated')) {
      await page.goto(baseUrl + '?paged&variable');
      await page.waitForFunction(() => globalThis.readerFixture?.api()?.getAnchor());
      for (const mode of ['blind-pixel', 'blind-line']) {
        await page.evaluate((mode) => {
          globalThis.autoFixture.setOpen(false);
          globalThis.autoFixture.controller.setMode(mode);
          globalThis.autoFixture.controller.setSpeed(12);
        }, mode);
        await page.evaluate(() => globalThis.autoFixture.controller.start());
        await page.waitForFunction(() => globalThis.autoFixture.controller.running);
        const overlay = page.locator('.reader-auto-reading-overlay:not([hidden])');
        await overlay.waitFor();
        const first = await overlay.boundingBox();
        await page.waitForFunction(
          (y) => {
            const overlay = document.querySelector('.reader-auto-reading-overlay:not([hidden])');
            return overlay && overlay.getBoundingClientRect().y > y;
          },
          first.y,
          { timeout: 5000 },
        );
        const second = await overlay.boundingBox();
        assert.ok(second.y > first.y, mode + ' must reveal page text');
        const anchor = await page.evaluate(() => JSON.stringify(globalThis.readerFixture.api().getAnchor()));
        await page.evaluate(async (mode) => {
          for (let i = 0; i < 80; i++) globalThis.readerFixture.api().advanceAutoReading(mode, 1000);
        }, mode);
        await page.waitForFunction(
          (previous) => JSON.stringify(globalThis.readerFixture.api().getAnchor()) !== previous,
          anchor,
          { timeout: 8000 },
        );
        assert.equal(await page.evaluate(() => globalThis.readerFixture.flow), 'paginated');
        await page.evaluate(() => globalThis.autoFixture.controller.stop());
        assert.equal(await page.locator('.reader-auto-reading-overlay:not([hidden])').count(), 0);
      }
      await page.evaluate(() => globalThis.readerFixture.api().scrubTo(1));
      await page.evaluate(() => globalThis.autoFixture.controller.start());
      await page.waitForFunction(() => globalThis.autoFixture.controller.running);
      await page.locator('.reader-auto-reading-overlay:not([hidden])').waitFor();
      await page.evaluate(() => {
        for (let i = 0; i < 100; i++) globalThis.readerFixture.api().advanceAutoReading('blind-line', 1);
      });
      await page.waitForFunction(() => !globalThis.autoFixture.controller.running, undefined, { timeout: 8000 });
      assert.deepEqual(errors, []);
      console.log(engine, width, 'paginated blind pixel/line, page turn, stop and chapter end passed');
      await page.close();
      continue;
    }
    await page.goto(baseUrl + '?long&variable');
    await page.waitForFunction(
      () => globalThis.autoFixture && document.querySelector('.reader-virtual-row [data-paragraph-id]'),
    );
    const geometry = await page.locator('[role=dialog]').evaluate((dialog) => {
      const rect = dialog.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        top: rect.top,
        width: innerWidth,
        height: innerHeight,
        overflow: dialog.scrollWidth > dialog.clientWidth + 1,
      };
    });
    assert.ok(
      geometry.left >= 0 &&
        geometry.right <= geometry.width &&
        geometry.top >= 0 &&
        geometry.bottom <= geometry.height &&
        !geometry.overflow,
      JSON.stringify(geometry),
    );
    assert.equal(await page.locator('input[type=checkbox]').isChecked(), false);
    await page.locator('input[type=range]').fill('12');
    await page.locator('.reader-auto-scroll-dialog .primary-btn').click();
    await page.waitForFunction(() => globalThis.autoFixture.controller.running);
    const start = await page.locator('.reader-scroll.is-active').evaluate((root) => root.scrollTop);
    await page.waitForTimeout(1800);
    const end = await page.locator('.reader-scroll.is-active').evaluate((root) => root.scrollTop);
    assert.ok(end - start > 30 && end - start < 180, JSON.stringify({ width, start, end }));
    await page
      .locator('.reader-scroll.is-active')
      .dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 200 });
    await page.waitForFunction(() => !globalThis.autoFixture.controller.running);
    await page.locator('.reader-scroll.is-active').dispatchEvent('pointerup', { pointerType: 'touch' });
    await page.evaluate(() => globalThis.readerFixture.api().scrollToParagraphIndex(11999, 'end', 'auto'));
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => globalThis.readerFixture.api().advanceAutoScroll(0)), 'end');
    await page.evaluate(() => globalThis.autoFixture.controller.start());
    await page.waitForFunction(() => !globalThis.autoFixture.controller.running, undefined, { timeout: 6000 });
    assert.deepEqual(await page.evaluate(() => globalThis.readerFixture.observations.openedChapters), []);
    assert.deepEqual(errors, []);
    console.log(engine, width, 'scroll distance', end - start, 'end stop and UI passed');
    if (process.argv.includes('--screenshots')) {
      await page.evaluate(() => globalThis.autoFixture.setOpen(true));
      await page.locator('[role=dialog]').waitFor({ state: 'visible' });
      await page.screenshot({ path: '.tmp/auto-scroll-' + engine + '-' + width + '.png' });
    }
    if (width === 834) {
      for (const mode of ['line', 'page', 'blind-pixel', 'blind-line', 'rsvp']) {
        await page.evaluate(async (mode) => {
          globalThis.autoFixture.setOpen(false);
          globalThis.autoFixture.controller.setMode(mode);
          await globalThis.readerFixture.api().scrollToParagraphIndex(40, 'start', 'auto');
        }, mode);
        await page.waitForTimeout(350);
        const initial = await page.locator('.reader-scroll.is-active').evaluate((root) => root.scrollTop);
        await page.evaluate(() => {
          globalThis.autoFixture.controller.setSpeed(12);
          globalThis.autoFixture.controller.start();
        });
        await page.waitForTimeout(1600);
        if (mode === 'line' || mode === 'page') {
          const moved = await page.locator('.reader-scroll.is-active').evaluate((root) => root.scrollTop);
          assert.ok(moved > initial + 10, JSON.stringify({ mode, initial, moved }));
        } else {
          const overlay = page.locator('.reader-auto-reading-overlay:not([hidden])');
          assert.equal(await overlay.count(), 1);
          if (mode === 'rsvp') assert.ok((await overlay.textContent()).trim().length > 0);
          else {
            const first = await overlay.boundingBox();
            assert.ok(first.height > 5);
            await page.waitForTimeout(650);
            const second = await overlay.boundingBox();
            assert.ok(second.y > first.y && second.height < first.height, mode + ' must reveal more text');
            assert.ok(Math.abs(second.y + second.height - first.y - first.height) < 1, 'blind bottom stays fixed');
          }
          if (process.argv.includes('--screenshots')) {
            await page.screenshot({ path: `.tmp/auto-reading-${engine}-${mode}.png` });
          }
        }
        await page.locator('.reader-auto-scroll-stop').click();
        assert.equal(await page.locator('.reader-auto-reading-overlay:not([hidden])').count(), 0);
        console.log(engine, mode, 'movement/presentation and stop passed');
      }
      await page.evaluate(() => globalThis.readerFixture.api().scrollToParagraphIndex(11999, 'end', 'auto'));
      await page.waitForTimeout(500);
      for (const mode of ['line', 'page', 'blind-pixel', 'blind-line', 'rsvp']) {
        const result = await page.evaluate(async (mode) => {
          const api = globalThis.readerFixture.api();
          api.resetAutoReading();
          let result;
          for (let i = 0; i < 2000; i++) {
            result = api.advanceAutoReading(mode, mode === 'blind-pixel' ? 100 : 1);
            if (result === 'end') break;
            if (result === 'waiting' || i % 40 === 39) await new Promise(requestAnimationFrame);
          }
          api.resetAutoReading();
          return result;
        }, mode);
        assert.equal(result, 'end', mode + ' must finish the last chapter');
      }
      console.log(engine, 'all modes finish the final chapter');
      await page.goto(baseUrl + '?long&images');
      await page.waitForFunction(() => globalThis.autoFixture && globalThis.readerFixture?.api());
      await page.evaluate(() => {
        globalThis.autoFixture.setOpen(false);
        globalThis.readerFixture.pauseImages();
        return globalThis.readerFixture.api().scrollToParagraphIndex(19, 'start', 'auto');
      });
      await page.locator('.reader-image-placeholder.is-loading').first().waitFor();
      assert.equal(await page.evaluate(() => globalThis.readerFixture.api().advanceAutoScroll(1)), 'waiting');
      await page.evaluate(() => globalThis.readerFixture.resumeImages());
      await page.waitForFunction(() => globalThis.readerFixture.api().advanceAutoScroll(0) === 'moving');
      console.log(engine, 'delayed illustration waits for loading');
    }
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
