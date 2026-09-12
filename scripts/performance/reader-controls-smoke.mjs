import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'vite';
import { chromium, devices, webkit } from 'playwright-core';

// Source positions and decoded illustrations, not just scrollTop. Synthetic touch
// ordering covers the application race; physical Safari/Chrome inertia is separate.
const bundle = await build({
  configFile: false,
  logLevel: 'error',
  build: { write: false, rollupOptions: { input: 'scripts/performance/reader-controls-fixture.mjs' } },
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
  for (const width of [320, 390, 834, 1280]) {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto(baseUrl);
    await page.waitForFunction(() => globalThis.controlsFixture);
    assert.equal(await page.locator('article[aria-current="location"]').textContent(), '115\uD654');
    const main = page.locator('.tts-compact-bar');
    const details = page.locator('.tts-compact-details');
    const checkControls = async () => {
      const overlap = await main.evaluate((bar) => {
        const bounds = bar.getBoundingClientRect();
        const controls = [...bar.querySelectorAll('button, select')]
          .filter((element) => element.getClientRects().length)
          .map((element) => element.getBoundingClientRect());
        return controls.some(
          (rect, index) =>
            rect.left < bounds.left - 1 ||
            rect.right > bounds.right + 1 ||
            controls
              .slice(index + 1)
              .some(
                (other) =>
                  Math.min(rect.right, other.right) - Math.max(rect.left, other.left) > 1 &&
                  Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top) > 1,
              ),
        );
      });
      assert.equal(overlap, false, `TTS controls overlap or overflow at ${width}px`);
    };
    await checkControls();
    if (width <= 980) {
      assert.equal(await details.isVisible(), false);
      const collapsed = await main.boundingBox();
      assert.ok(collapsed.height <= 64, `Collapsed bar too tall at ${width}: ${collapsed.height}`);
      await page.locator('.tts-compact-disclosure').click();
      assert.equal(await details.isVisible(), true);
      const expanded = await main.boundingBox();
      assert.ok(expanded.height <= 180, `Expanded options too tall at ${width}: ${expanded.height}`);
      assert.ok(expanded.x >= 0 && expanded.x + expanded.width <= width, 'Controls fit the viewport');
    } else assert.equal(await details.isVisible(), true);
    await checkControls();
    await page.locator('.tts-compact-timer select').selectOption('20');
    assert.equal(await page.evaluate(() => controlsFixture.timer), 20);
    await page.locator('[aria-label="\uCCAD\uCDE8 \uC124\uC815 \uC5F4\uAE30"]').click();
    assert.ok(await page.evaluate(() => controlEvents.includes('settings')));
    if (width <= 980) {
      if (process.argv.includes('--screenshots'))
        await page.screenshot({ path: `.tmp/reader-controls-${engine}-${width}.png` });
      await page.locator('.tts-compact-disclosure').click();
      assert.equal(await details.isVisible(), false);
    }
    const families = [];
    for (const font of ['serif', 'sans', 'mono']) {
      await page.evaluate((font) => controlsFixture.setFontId(`builtin-${font}`), font);
      await page.waitForFunction(
        (font) =>
          getComputedStyle(document.getElementById('font-sample')).fontFamily.includes(
            font === 'serif' ? 'AppleMyungjo' : font === 'sans' ? 'Apple SD Gothic Neo' : 'Menlo',
          ),
        font,
      );
      families.push(await page.locator('#font-sample').evaluate((element) => getComputedStyle(element).fontFamily));
    }
    assert.equal(new Set(families).size, 3, 'Built-in selection changes the applied CSS family');
    await page.close();
    console.log(
      JSON.stringify({ engine, width, currentRelease: 115, ttsDisclosure: true, distinctFamilies: families.length }),
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
