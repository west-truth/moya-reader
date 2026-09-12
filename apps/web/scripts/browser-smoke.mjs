import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { syntheticComic, syntheticEpub, syntheticPdf } from './browser-fixtures.mjs';

// Real static HTTP serving is needed to exercise service-worker installation/offline boot.
// Only synthetic books and fresh browser contexts are used; no user profile or cloud account.
const dist = resolve('apps/web/dist');
const { base } = JSON.parse(await readFile(resolve(dist, 'offline-manifest.json'), 'utf8'));
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};
const requests = [];
let serveUpdate = false;
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  requests.push(pathname);
  if (!pathname.startsWith(base)) {
    res.writeHead(404).end();
    return;
  }
  const relative = decodeURIComponent(pathname.slice(base.length)) || 'index.html';
  const file = resolve(dist, relative);
  if (!file.startsWith(dist + sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    let bytes = await readFile(file);
    if (serveUpdate && relative === 'sw.js')
      bytes = Buffer.from(bytes.toString().replace(/"version":"([^"]+)"/, '"version":"$1-update-smoke"'));
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'text/plain', 'Cache-Control': 'no-cache' });
    res.end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let activePage;
try {
  browser = await chromium.launch({ channel: process.env.READER_UI_BROWSER_CHANNEL || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + base);
  await page.getByRole('button', { name: '설정 열기', exact: true }).waitFor();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 45000 });
  assert(
    !requests.some((path) => path.endsWith('.wasm') || path.includes('pdf.worker')),
    'First installation must not download unused document engines',
  );
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL), origin + base + 'sw.js');
  await page.getByRole('button', { name: /동기화 열기/ }).click();
  await page.getByRole('link', { name: /데스크톱 (출시 확인|앱 다운로드)/ }).waitFor();
  await page.getByRole('button', { name: '모든 형식 오프라인 준비', exact: true }).click();
  await page.getByText('모든 형식 준비됨', { exact: true }).waitFor({ timeout: 90000 });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.locator('.sync-panel').evaluate((panel) => panel.scrollWidth <= panel.clientWidth + 1),
    'Mobile Web settings overflow horizontally',
  );
  await page.getByRole('region', { name: '앱과 오프라인', exact: true }).scrollIntoViewIfNeeded();
  await mkdir('.tmp/web-pages-check', { recursive: true });
  await page.screenshot({ path: '.tmp/web-pages-check/offline-settings.png', fullPage: true });
  await page.getByText('웹에서 읽던 책 옮기기', { exact: true }).click();
  await mkdir('.tmp/web-pages-check', { recursive: true });
  await page.screenshot({ path: '.tmp/web-pages-check/desktop-handoff.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '동기화 패널 닫기', exact: true }).click();
  await context.setOffline(true);
  await page.getByRole('button', { name: '책 가져오기', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'Pages smoke.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('제1화 시작\n\n브라우저에서 읽고 백업으로 옮기는 합성 소설입니다.\n\n두 번째 문단입니다.\n'),
  });
  await page.getByRole('button', { name: '가져오기 시작', exact: true }).click();
  await page.getByRole('button', { name: '첫 화 보기', exact: true }).first().click();
  await page.locator('.reader-paragraph').first().waitFor();
  await page.locator('.reader-scroll').click();
  await page.locator('.reader-topbar').getByRole('button', { name: '북마크 추가', exact: true }).click();
  await page.locator('.reader-topbar').getByRole('button', { name: '북마크 제거', exact: true }).waitFor();
  await page.getByRole('button', { name: '화 목록으로', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '백업 및 복원 열기', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '백업 만들기', exact: true }).click();
  const download = await downloading;
  const backupPath = resolve('.tmp/web-pages-check/synthetic-backup.zip');
  await download.saveAs(backupPath);
  await page.getByRole('button', { name: '백업 패널 닫기', exact: true }).click();
  assert(
    await page.evaluate(() => Boolean(JSON.parse(localStorage.getItem('moya-web-data-safety-v1')).lastExportedAt)),
    'Only successful backup exports should record their creation date',
  );
  await context.setOffline(true);
  await page.reload();
  await page.getByText('Pages smoke', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: /동기화 열기/ }).click();
  await page.getByRole('link', { name: /데스크톱 (출시 확인|앱 다운로드)/ }).waitFor();
  await context.setOffline(false);

  // A changed worker must wait for consent and retain full offline preparation across updates.
  const currentVersion = await page.evaluate(
    () =>
      new Promise((done) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => {
          channel.port1.close();
          done(data.version);
        };
        navigator.serviceWorker.controller.postMessage({ type: 'OFFLINE_STATUS' }, [channel.port2]);
      }),
  );
  serveUpdate = true;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting));
  const stillCurrent = await page.evaluate(
    () =>
      new Promise((done) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => {
          channel.port1.close();
          done(data.version);
        };
        navigator.serviceWorker.controller.postMessage({ type: 'OFFLINE_STATUS' }, [channel.port2]);
      }),
  );
  assert.equal(stillCurrent, currentVersion, 'An update must not activate without user action');
  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: '새 버전 적용', exact: true }).click(),
  ]);
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return Boolean(registration?.active && !registration.waiting);
  });
  await page.getByRole('button', { name: /동기화 열기/ }).click();
  await page.getByText('모든 형식 준비됨', { exact: true }).waitFor();
  await page.getByRole('button', { name: '동기화 패널 닫기', exact: true }).click();
  await context.setOffline(true);
  await page.reload();
  await page.getByText('Pages smoke', { exact: true }).first().waitFor();

  // New formats are opened for the first time without any network access.
  const png = await readFile(resolve(dist, 'icons/moya-192.png'));
  const formats = [
    {
      name: 'Offline EPUB.epub',
      mimeType: 'application/epub+zip',
      buffer: await syntheticEpub(),
      selector: '.reader-paragraph',
    },
    {
      name: 'Offline comic.cbz',
      mimeType: 'application/vnd.comicbook+zip',
      buffer: await syntheticComic(png),
      selector: '.fixed-doc-viewport img',
    },
    { name: 'Offline PDF.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(), selector: '.fixed-doc-canvas' },
  ];
  for (const { selector, ...file } of formats) {
    await page.goto(origin + base);
    await page.getByRole('button', { name: '책 가져오기', exact: true }).click();
    await page.locator('input[type=file]').setInputFiles(file);
    await page.getByRole('button', { name: '가져오기 시작', exact: true }).click();
    await page.locator('.import-dialog').waitFor({ state: 'hidden' });
    const title = file.name.replace(/\.(epub|cbz|pdf)$/, '');
    const first = page
      .locator('.book-continue-action')
      .and(page.getByRole('button', { name: new RegExp('^' + title + ' ') }));
    const reading = page.locator('.source-hub-reading-button');
    const alreadyOpen = page.locator(selector);
    await first.first().or(reading.first()).or(alreadyOpen.first()).first().waitFor();
    if (await first.first().isVisible()) await first.first().click();
    else if (await reading.first().isVisible()) await reading.first().click();
    await page.locator(selector).first().waitFor();
    if (selector.endsWith('img'))
      await page
        .locator(selector)
        .first()
        .evaluate((img) => img.decode());
    if (selector.endsWith('canvas'))
      await page.waitForFunction(() => document.querySelector('.fixed-doc-canvas')?.width > 1);
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `Mobile ${file.name} overflows`,
    );
    await page.screenshot({
      path: `.tmp/web-pages-check/${file.name.split('.')[0].replaceAll(' ', '-')}.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
  }

  // A second clean profile exercises the same backup repository consumed by the desktop entry.
  const destination = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const restored = await destination.newPage();
  activePage = restored;
  restored.setDefaultTimeout(20000);
  restored.on('pageerror', (error) => errors.push(error.message));
  await restored.goto(origin + base);
  await restored.getByRole('button', { name: '백업 및 복원 열기', exact: true }).click();
  await restored.locator('.backup-dialog input[type=file]').setInputFiles(backupPath);
  await restored.getByRole('button', { name: '검사한 백업 복원', exact: true }).click();
  await restored.locator('.backup-dialog').waitFor({ state: 'hidden' });
  await restored.getByText('Pages smoke', { exact: true }).first().waitFor();
  await restored.locator('.book-continue-action').first().click();
  await restored.locator('.reader-paragraph').first().waitFor();
  await restored.locator('.reader-scroll').click();
  await restored.locator('.reader-topbar').getByRole('button', { name: '북마크 제거', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assert(
    requests.every((path) => path.startsWith(base) || path === '/favicon.ico'),
    `Assets escaped the deployment base: ${JSON.stringify([...new Set(requests.filter((path) => !path.startsWith(base) && path !== '/favicon.ico'))])}`,
  );
  console.log(
    JSON.stringify({
      base,
      serviceWorker: true,
      offlineReload: true,
      lazyInitialCache: true,
      offlineFirstImport: ['TXT', 'EPUB', 'CBZ', 'PDF'],
      explicitUpdateAndOfflineRetention: true,
      mobileSettingsAndFormats: true,
      import: true,
      readingAndBookmark: true,
      backupRestore: true,
      desktopHandoff: true,
      pageErrors: errors.length,
      nativeInstallerTested: false,
    }),
  );
} catch (error) {
  console.error('Failed browser step:', error);
  console.error((await activePage?.locator('body').innerText())?.slice(0, 9000));
  console.error(
    'PWA diagnostic:',
    await activePage?.evaluate(async () => ({
      secure: isSecureContext,
      controller: Boolean(navigator.serviceWorker.controller),
      registrations: (await navigator.serviceWorker.getRegistrations()).map((registration) => ({
        scope: registration.scope,
        active: registration.active?.state,
        waiting: registration.waiting?.state,
        installing: registration.installing?.state,
      })),
      caches: await caches.keys(),
    })),
  );
  console.error('Recent static requests:', requests.slice(-15));
  throw error;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
