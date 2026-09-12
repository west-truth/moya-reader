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
  const open = async (query) => {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${baseUrl}?${query}`);
    await page.waitForFunction(() => globalThis.readerFixture?.api());
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      const root = document.querySelector('[data-reader-layer="scroll"]');
      globalThis.readerGeometry = {
        trace: [],
        writes: [],
        touch(type, y = 400) {
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientY: y }] });
          root.dispatchEvent(event);
        },
        capture() {
          return {
            top: root.scrollTop,
            height: root.scrollHeight,
            rows: [...root.querySelectorAll('[data-index]')].map((row) => ({
              index: +row.dataset.index,
              y: row.getBoundingClientRect().top,
              height: row.getBoundingClientRect().height,
              loading: !!row.querySelector('.is-loading'),
            })),
          };
        },
        async step(delta) {
          root.scrollTop += delta;
          await new Promise(requestAnimationFrame);
          this.trace.push(this.capture());
        },
      };
      const scrollTo = root.scrollTo.bind(root);
      root.scrollTo = (...args) => {
        readerGeometry.writes.push(args);
        scrollTo(...args);
      };
    });
    return page;
  };

  // Cold measurements just above the screen must not move the text underneath it.
  for (const query of process.argv.includes('--images-only') ? [] : ['long&variable', 'variable']) {
    const page = await open(query);
    const restoredIndex = query.includes('long') ? 2000 : 100;
    await page.evaluate((index) => readerFixture.restore(index), restoredIndex);
    await page.waitForFunction(
      (index) => document.querySelector(`[data-index="${index}"] [data-paragraph-id]`),
      restoredIndex,
    );
    await page.waitForTimeout(550);
    const during = await page.evaluate(async () => {
      readerGeometry.writes.length = 0;
      readerGeometry.touch('touchstart');
      for (let index = 0; index < 55; index++) {
        readerGeometry.touch('touchmove', 400 + index * 4);
        await readerGeometry.step(-40);
      }
      readerGeometry.touch('touchend');
      for (let index = 0; index < 25; index++) await readerGeometry.step(-20);
      return readerGeometry.capture();
    });
    await page.waitForTimeout(650);
    const result = await page.evaluate(() => {
      let maximumShift = 0;
      let samples = 0;
      for (let index = 1; index < readerGeometry.trace.length; index++) {
        const previous = readerGeometry.trace[index - 1],
          current = readerGeometry.trace[index];
        const anchor = previous.rows.find((row) => row.y + row.height > 100 && !row.loading);
        const matched = anchor && current.rows.find((row) => row.index === anchor.index && !row.loading);
        if (!matched) continue;
        samples++;
        maximumShift = Math.max(maximumShift, Math.abs(matched.y - anchor.y + current.top - previous.top));
      }
      return { maximumShift, samples, writes: readerGeometry.writes, after: readerGeometry.capture() };
    });
    assert.ok(result.samples > 60, 'Compare actual overlapping source rows across frames');
    assert.ok(result.maximumShift <= 2, `Visible source jumped ${result.maximumShift}px during upward scrolling`);
    assert.deepEqual(result.writes, [], 'No programmatic scrollTo during the gesture');
    const anchor = during.rows.find((row) => row.y + row.height > 100 && !row.loading);
    const after = result.after.rows.find((row) => row.index === anchor.index);
    assert.ok(
      after && Math.abs(after.y - anchor.y) <= 2,
      'Rebasing after inertia must keep the same source at the same screen position',
    );
    assert.ok(result.after.rows.length < 80, 'Long chapters retain bounded DOM');
    console.log(
      JSON.stringify({
        engine,
        query,
        maximumShift: result.maximumShift,
        samples: result.samples,
        rebaseShift: after.y - anchor.y,
      }),
    );
    if (query.includes('long')) {
      await page.evaluate(() => readerFixture.api().scrollToParagraphIndex(4000, 'start', 'auto'));
      await page.waitForTimeout(500);
      await page.evaluate(async () => {
        readerGeometry.touch('touchstart');
        for (let index = 0; index < 30; index++) await readerGeometry.step(-40);
        // Explicit navigation must still reach a destination above the temporary
        // coordinate origin, without a later idle rebase pulling it back.
        await readerFixture.api().scrubTo(0);
        readerGeometry.touch('touchend');
      });
      await page.waitForTimeout(650);
      const start = await page.locator('[data-index="0"]').evaluate((row) => row.getBoundingClientRect().top);
      assert.ok(Math.abs(start) <= 2, `Explicit start jump landed ${start}px away after measurements`);
    }
    await page.close();
  }

  // Once reading is open, a pending explicit jump must still yield to user scrolling.
  if (!process.argv.includes('--images-only')) {
    const page = await open('long&variable');
    await page.evaluate(() => {
      readerFixture.pausePages();
      void readerFixture.api().scrollToParagraphIndex(2000, 'start', 'auto');
    });
    await page.waitForFunction(() => readerFixture.pageRequests.includes(16));
    const before = await page.evaluate(async () => {
      readerGeometry.touch('touchstart');
      readerGeometry.touch('touchmove', 500);
      await readerGeometry.step(180);
      return readerGeometry.capture();
    });
    await page.evaluate(() => readerFixture.resumePages());
    await page.waitForTimeout(450);
    const after = await page.evaluate(() => readerGeometry.capture());
    assert.equal(after.top, before.top, 'A late explicit jump must not override user scrolling');
    await page.evaluate(() => readerGeometry.touch('touchend'));
    await page.evaluate(() => readerFixture.api().scrollToParagraphIndex(2000, 'start', 'auto'));
    await page.waitForFunction(() => document.querySelector('[data-index="2000"] [data-paragraph-id]'));
    console.log(JSON.stringify({ engine, scenario: 'navigation-interrupt', delta: after.top - before.top }));
    await page.close();
  }

  // Decode a real image, unmount it, and delay its bytes when returning from below.
  {
    const page = await open('long&variable&images');
    await page.evaluate(() => readerFixture.api().scrollToParagraphIndex(2019, 'start', 'auto'));
    await page
      .waitForFunction(
        () => {
          const image = document.querySelector('[data-index="2019"] img');
          return image?.naturalWidth > 0;
        },
        undefined,
        { timeout: 5000 },
      )
      .catch(async (error) => {
        console.log(
          JSON.stringify(
            await page.evaluate(() => ({
              ...readerGeometry.capture(),
              writes: readerGeometry.writes,
              requests: readerFixture.imageRequests,
              images: [...document.images].map((image) => ({ src: image.src, width: image.naturalWidth })),
            })),
          ),
        );
        throw error;
      });
    await page.waitForTimeout(450);
    const measured = await page.locator('[data-index="2019"]').evaluate((row) => row.getBoundingClientRect().height);
    await page.evaluate(() => readerFixture.api().scrollToParagraphIndex(2050, 'start', 'auto'));
    await page.waitForFunction(() => !document.querySelector('[data-index="2019"]'));
    await page.evaluate(() => readerFixture.pauseImages());
    await page.evaluate(() => readerFixture.api().scrollToParagraphIndex(2020, 'start', 'auto'));
    await page.waitForFunction(() => document.querySelector('[data-index="2019"] .is-loading'));
    await page.waitForTimeout(250);
    const placeholder = await page.locator('[data-index="2019"]').evaluate((row) => row.getBoundingClientRect().height);
    assert.ok(Math.abs(placeholder - measured) <= 1, `Image height collapsed from ${measured} to ${placeholder}`);
    await page.evaluate(async () => {
      readerGeometry.touch('touchstart');
      readerGeometry.touch('touchmove', 500);
      await readerGeometry.step(-100);
    });
    const before = await page.locator('[data-index="2020"]').evaluate((row) => row.getBoundingClientRect().top);
    await page.evaluate(() => readerFixture.resumeImages());
    await page.waitForFunction(() => {
      const image = document.querySelector('[data-index="2019"] img');
      return image?.naturalWidth > 0;
    });
    await page.waitForTimeout(300);
    const after = await page.locator('[data-index="2020"]').evaluate((row) => row.getBoundingClientRect().top);
    assert.ok(
      Math.abs(after - before) <= 2,
      `Reloading an illustration moved the reading position by ${after - before}px`,
    );
    console.log(
      JSON.stringify({ engine, scenario: 'image-return', measured, placeholder, sourceShift: after - before }),
    );
    await page.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
