import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';
import { chromium } from 'playwright-core';
import { findTemporaryLoopbackPort } from './lib/temporary-loopback-port.mjs';

// Run after `pnpm build`. A fresh browser receives only local dist assets; no
// existing profile, backend, provider, or external network is used.
const dist = resolve('dist');
const origin = `http://127.0.0.1:${await findTemporaryLoopbackPort()}`;
const types = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};
let browser;
try {
  await readFile(resolve(dist, 'index.html'));
  browser = await chromium.launch({ channel: process.env.READER_UI_BROWSER_CHANNEL || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/runtime-config.js') {
      return route.fulfill({
        contentType: 'application/javascript',
        body: 'globalThis.__MOYA_RUNTIME_CONFIG__ = Object.freeze({schemaVersion: 1});',
      });
    }
    const file = resolve(dist, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!file.startsWith(dist + sep)) return route.abort();
    try {
      return await route.fulfill({
        body: await readFile(file),
        contentType: types[extname(file)] || 'application/octet-stream',
      });
    } catch {
      return route.fulfill({ status: 404, body: '' });
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('button', { name: '더보기', exact: true }).click();
  await page.getByRole('button', { name: '가져오기', exact: true }).click();
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 1500;
    const paint = canvas.getContext('2d');
    paint.fillStyle = '#ffbb44';
    paint.fillRect(0, 0, 300, 750);
    paint.fillStyle = '#22bbaa';
    paint.fillRect(0, 750, 300, 750);
    return canvas.toDataURL().split(',')[1];
  });
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await zip.add('001.png', new Uint8ArrayReader(Buffer.from(png, 'base64')));
  await zip.add('002.png', new Uint8ArrayReader(Buffer.from(png, 'base64')));
  await page.locator('input[type=file]').setInputFiles({
    name: 'Synthetic UI comic.cbz',
    mimeType: 'application/vnd.comicbook+zip',
    buffer: Buffer.from(await zip.close()),
  });
  await page.getByRole('button', { name: '가져오기 시작', exact: true }).click();
  await page.locator('.fixed-doc-viewport img').first().waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });
  const currentPage = page.getByRole('textbox', { name: '현재 페이지', exact: true });
  const waitForPage = (value) =>
    page.waitForFunction((value) => document.querySelector('input[aria-label="현재 페이지"]')?.value === value, value);

  await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
  await waitForPage('2');
  await page.getByRole('button', { name: '이전 페이지', exact: true }).click();
  await waitForPage('1');
  await page.getByRole('button', { name: '다음 페이지', exact: true }).focus();
  await page.keyboard.press('Space');
  await waitForPage('2');
  await currentPage.fill('abc');
  await currentPage.press('Enter');
  assert.equal(await currentPage.inputValue(), '2', 'Invalid page input must retain the current page');
  assert.ok(!(await page.locator('body').innerText()).includes('NaN'));
  await currentPage.fill('1');
  await currentPage.press('Enter');
  await waitForPage('1');
  await page.getByTitle('너비 맞춤', { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const viewport = document.querySelector('.fixed-doc-viewport');
    return viewport.scrollHeight > viewport.clientHeight + 250;
  });
  // Finish focal restoration before selecting a deterministic touch starting point.
  await page.waitForTimeout(250);
  await page.locator('.fixed-doc-viewport').evaluate((element) => {
    element.scrollTop = 0;
  });
  const session = await context.newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 190, y: 650 }] });
  for (let y = 620; y >= 260; y -= 30) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 190, y }] });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const scrollTop = await page.locator('.fixed-doc-viewport').evaluate((element) => element.scrollTop);
  assert.ok(scrollTop >= 250, `Expected vertical pan at 100% fit-width, got ${scrollTop}`);
  assert.equal(await currentPage.inputValue(), '1', 'Vertical pan must not turn the page');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        pointerPageButtons: true,
        spaceActivatesButton: true,
        invalidPagePreserved: true,
        mobileFitWidthPan: scrollTop,
        verticalPanPreservesPage: true,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
