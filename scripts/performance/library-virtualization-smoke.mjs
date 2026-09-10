import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'vite';
import { chromium, webkit } from 'playwright-core';
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
  browser =
    process.env.READER_UI_BROWSER_ENGINE === 'webkit'
      ? await webkit.launch({ headless: true })
      : await chromium.launch({ channel: process.env.READER_UI_BROWSER_CHANNEL || 'msedge', headless: true });
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
  assert.equal(await page.getByText('Ctrl K', { exact: true }).count(), 0);
  await page.setViewportSize({ width: 834, height: 1194 });
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  await page.keyboard.press('Control+K');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '책장 검색');
  const evidence = [];
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1536, height: 960 },
    { width: 1366, height: 768 },
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
    { width: 834, height: 1194 },
    { width: 768, height: 1024 },
    { width: 1194, height: 834 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    let topbar;
    if (viewport.width >= 700) {
      topbar = await page.evaluate(() => {
        const header = document.querySelector('.library-topbar');
        const search = document.querySelector('.library-search');
        const actions = document.querySelector('.library-topbar-actions');
        const headerRect = header.getBoundingClientRect();
        const searchRect = search.getBoundingClientRect();
        const actionsRect = actions.getBoundingClientRect();
        return {
          gap: actionsRect.left - searchRect.right,
          leftInset: searchRect.left - headerRect.left,
          rightInset: headerRect.right - actionsRect.right,
          overflow: header.scrollWidth - header.clientWidth,
        };
      });
      assert.ok(topbar.gap >= 10, `Tablet library header controls overlap by ${-topbar.gap}px`);
      assert.ok(topbar.leftInset >= 15, `Tablet library search escaped its header by ${-topbar.leftInset}px`);
      assert.ok(topbar.rightInset >= 15, `Tablet library actions escaped their header by ${-topbar.rightInset}px`);
      assert.ok(topbar.overflow <= 1, `Tablet library header overflowed by ${topbar.overflow}px`);
    }
    for (const viewMode of ['grid', 'list']) {
      await page.evaluate((mode) => globalThis.libraryFixture.update({ viewMode: mode, query: '' }), viewMode);
      const selector = viewMode === 'grid' ? '.book-card' : '.book-list-row';
      await page.waitForFunction((selector) => document.querySelectorAll(selector).length > 0, selector);
      const mounted = await page.locator(selector).count();
      assert.ok(mounted < 120, `Expected bounded ${viewMode} cards, saw ${mounted}`);
      let gridRemainder;
      if (viewMode === 'grid' && viewport.width >= 700) {
        gridRemainder = await page
          .locator('.library-virtual-row')
          .first()
          .evaluate((element) => {
            const row = element.getBoundingClientRect();
            const cards = [...element.querySelectorAll('.book-card')]
              .map((card) => card.getBoundingClientRect())
              .filter((card) => Math.abs(card.top - row.top) <= 2);
            return row.right - Math.max(...cards.map((card) => card.right));
          });
        assert.ok(Math.abs(gridRemainder) <= 2, `Cover grid left ${gridRemainder}px unused at ${viewport.width}px`);
      }
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
      evidence.push({
        ...viewport,
        viewMode,
        mounted,
        gridRemainder,
        topbar,
        lastItemReachable: true,
        queryReset: true,
      });
    }
  }
  await page.evaluate(() => globalThis.libraryFixture.update({ query: '', selectionMode: true }));
  await page.waitForFunction(() => document.body.textContent.includes('1000권 선택됨'));
  assert.ok((await page.locator('.book-list-row').count()) < 120);
  const batchBar = page.getByRole('toolbar', { name: '선택한 책 일괄 작업' });
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 390, height: 844 },
    { width: 667, height: 375 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: '상세 작업 펼치기' }).waitFor();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByLabel('일괄 태그').isVisible(), false);
    assert.ok((await batchBar.boundingBox()).height <= 60, 'Collapsed mobile bar must remain one compact row');
    for (const label of [
      '선택한 책 즐겨찾기 설정',
      '선택한 책 정보 내보내기',
      '선택한 책 휴지통으로 이동',
      '선택 종료',
    ]) {
      const bounds = await batchBar.getByRole('button', { name: label, exact: true }).boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width, `${label} escaped the viewport`);
    }
    for (const expanded of [false, true]) {
      if (expanded) await page.getByRole('button', { name: '상세 작업 펼치기' }).click();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (viewport.width === 390 && process.env.LIBRARY_UI_SCREENSHOT_DIR) {
        await mkdir(process.env.LIBRARY_UI_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.LIBRARY_UI_SCREENSHOT_DIR, `library-batch-${expanded ? 'expanded' : 'collapsed'}.png`),
        });
      }
      for (const viewMode of ['grid', 'list']) {
        await page.evaluate((viewMode) => globalThis.libraryFixture.update({ viewMode }), viewMode);
        await page.waitForFunction(
          (selector) => document.querySelector(selector) !== null,
          viewMode === 'grid' ? '.book-card' : '.book-list-row',
        );
        // Let the view-mode scroll reset finish before scrolling the new collection.
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        await page.locator('.library-main').evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const last = page.getByRole('button', { name: /Synthetic novel 0999 선택/ });
        await last.waitFor();
        await page
          .waitForFunction(() => {
            const last = document.querySelector('[data-library-item="999"] button[aria-pressed]');
            if (!last) return false;
            const rect = last.getBoundingClientRect();
            return rect.bottom <= document.querySelector('.library-batch-bar').getBoundingClientRect().top;
          })
          .catch(async (error) => {
            console.error(
              JSON.stringify(
                await page.evaluate(() => {
                  const main = document.querySelector('.library-main');
                  const last = document.querySelector('[data-library-item="999"] button[aria-pressed]');
                  return {
                    mainHeight: main.clientHeight,
                    scrollTop: main.scrollTop,
                    scrollHeight: main.scrollHeight,
                    padding: getComputedStyle(main).paddingBottom,
                    last: last?.getBoundingClientRect().toJSON(),
                    bar: document.querySelector('.library-batch-bar').getBoundingClientRect().toJSON(),
                  };
                }),
              ),
            );
            throw error;
          });
        const selected = await last.getAttribute('aria-pressed');
        await last.click();
        assert.notEqual(
          await last.getAttribute('aria-pressed'),
          selected,
          'Last book must remain selectable above the toolbar',
        );
      }
    }
    assert.ok((await batchBar.boundingBox()).height <= viewport.height * 0.55 + 2);
    await page.getByRole('button', { name: '상세 작업 접기' }).click();
  }
  await page.getByRole('button', { name: '선택한 책 즐겨찾기 설정', exact: true }).click();
  await page.getByRole('button', { name: '선택한 책 정보 내보내기', exact: true }).click();
  await page.getByRole('button', { name: '선택한 책 휴지통으로 이동', exact: true }).click();
  await page.getByRole('button', { name: '상세 작업 펼치기' }).click();
  await page.getByLabel('일괄 태그').fill('Test tag');
  await page.getByRole('button', { name: '추가', exact: true }).click();
  await page.getByRole('button', { name: '선택 책장에 추가', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => globalThis.libraryBatchActions), [
    { kind: 'set_favorite', favorite: true },
    { kind: 'export_metadata' },
    { kind: 'move_to_trash' },
    { kind: 'add_tag', tag: 'Test tag' },
    { kind: 'add_to_shelf', shelfId: 'shelf-1' },
  ]);
  await batchBar.getByRole('button', { name: '선택 종료', exact: true }).click();
  await batchBar.waitFor({ state: 'hidden' });
  await page.evaluate(() => globalThis.libraryFixture.update({ selectionMode: true }));
  assert.equal(await page.getByRole('button', { name: '상세 작업 펼치기' }).getAttribute('aria-expanded'), 'false');
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await page.getByLabel('일괄 태그').isVisible(), true);
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
      {
        evidence,
        searchShortcutFocused: true,
        shortcutHintHidden: true,
        all1000Selected: true,
        mobileBatchCollapseAndActions: true,
        lastBookSelectableWithExpandedBar: true,
        resizeFocusPreserved: true,
        sequentialTab: true,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
