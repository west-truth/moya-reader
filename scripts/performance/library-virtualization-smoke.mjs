import assert from 'node:assert/strict';
import { build } from 'vite';
import { chromium } from 'playwright-core';
import { findTemporaryLoopbackPort } from '../lib/temporary-loopback-port.mjs';

// Isolated, synthetic component gate: no App bootstrap, user IndexedDB, or provider requests.
const bundle = await build({
  configFile: false,
  logLevel: 'error',
  build: { write: false, rollupOptions: { input: 'scripts/performance/library-virtualization-fixture.mjs' } },
});
const output = bundle.output;
const entry = output.find((asset) => asset.type === 'chunk' && asset.isEntry);
const styles = output.filter((asset) => asset.fileName.endsWith('.css'));
const assets = new Map(output.map((asset) => [`/${asset.fileName}`, asset]));
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${styles.map((style) => `<link rel="stylesheet" href="/${style.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
const baseUrl = `http://127.0.0.1:${await findTemporaryLoopbackPort()}`;
let browser;
try {
  console.log('Production library fixture built.');
  browser = await chromium.launch({ channel: process.env.READER_UI_BROWSER_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__library-virtualization')
      return route.fulfill({
        contentType: 'text/html',
        body: html,
      });
    const asset = assets.get(url.pathname);
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
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.goto(`${baseUrl}/__library-virtualization`);
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length > 0);
  const evidence = [];
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const viewMode of ['grid', 'list']) {
      await page.evaluate((mode) => globalThis.libraryFixture.update({ viewMode: mode, query: '' }), viewMode);
      const selector = viewMode === 'grid' ? '.book-card' : '.book-list-row';
      await page.waitForFunction((selector) => document.querySelectorAll(selector).length > 0, selector);
      const mounted = await page.locator(selector).count();
      assert.ok(mounted < 120, `Expected bounded ${viewMode} cards, saw ${mounted}`);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await page.locator('.library-main').evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        try {
          await page.getByRole('heading', { name: 'Synthetic novel 0999', exact: true }).waitFor({ timeout: 1000 });
          break;
        } catch (error) {
          if (attempt === 7) throw error;
        }
      }
      const last = page.getByRole('heading', { name: 'Synthetic novel 0999', exact: true });
      assert.equal(await last.count(), 1);
      await page.evaluate(() => globalThis.libraryFixture.update({ query: 'novel 00' }));
      await page.waitForFunction(() => document.querySelectorAll('.book-card, .book-list-row').length === 100);
      assert.equal(await page.getByRole('heading', { name: 'Synthetic novel 0000', exact: true }).count(), 1);
      assert.equal(await page.locator('.library-main').evaluate((element) => element.scrollTop), 0);
      evidence.push({ ...viewport, viewMode, mounted, lastItemReachable: true, queryReset: true });
    }
  }
  await page.evaluate(() => globalThis.libraryFixture.update({ query: '', selectionMode: true }));
  await page.waitForFunction(() => document.body.textContent.includes('1000권 선택됨'));
  assert.ok((await page.locator('.book-list-row').count()) < 120);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => globalThis.libraryFixture.update({ selectionMode: false, viewMode: 'grid' }));
  await page.locator('[data-library-item="4"] button').first().focus();
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.library-virtual-collection')).gridTemplateColumns.split(' ').length >=
      4,
  );
  await page.waitForFunction(() => document.activeElement.closest('[data-library-item]')?.dataset.libraryItem === '4');
  await page.locator('.library-main').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement.closest('[data-library-item]')?.dataset.libraryItem === '5'))
      break;
  }
  assert.equal(
    await page.evaluate(() => document.activeElement.closest('[data-library-item]')?.dataset.libraryItem),
    '5',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      { evidence, all1000Selected: true, resizeFocusPreserved: true, sequentialTab: true, browserErrors: errors },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
