import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const server = await createServer({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  const ids = await page.evaluate(async () => {
    const { createLibraryShelf } = await import('/src/storage/library-management-store.ts');
    const { writeConfig, newTab } = await import('/src/features/discovery/discovery-config.ts');
    writeConfig(`${location.origin}:local:local`, {
      version: 1,
      tabs: [
        { ...newTab('둘러보기'), id: 'browse' },
        { ...newTab('소설'), id: 'novels' },
      ],
    });
    return [
      (await createLibraryShelf({ name: 'Normal' })).shelf.id,
      (await createLibraryShelf({ name: 'Other' })).shelf.id,
    ];
  });
  await page.reload({ waitUntil: 'networkidle' });
  const settings = async () => {
    await page
      .getByRole('button', { name: /^설정( 열기)?$/ })
      .first()
      .click();
  };
  const select = () => page.getByRole('combobox', { name: '시작 화면', exact: true });
  await settings();
  await select().selectOption(`shelf:${ids[0]}`);
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await page.getByRole('navigation', { name: '사용자 책장' }).getByRole('button', { name: /Other/ }).click();
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(
    await page
      .getByRole('navigation', { name: '사용자 책장' })
      .getByRole('button', { name: /Normal/ })
      .getAttribute('aria-current'),
    'page',
  );
  await settings();
  assert.equal(await select().inputValue(), `shelf:${ids[0]}`);
  await select().selectOption('library');
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await page.getByRole('navigation', { name: '사용자 책장' }).getByRole('button', { name: /Other/ }).click();
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(
    await page
      .getByRole('navigation', { name: '사용자 책장' })
      .getByRole('button', { name: /모든 작품/ })
      .getAttribute('aria-current'),
    'page',
  );
  await settings();
  await select().waitFor();
  const tabs = await select()
    .locator('option')
    .evaluateAll((options) =>
      options.filter((o) => o.value.startsWith('tab:')).map((o) => ({ value: o.value, label: o.textContent })),
    );
  await select().selectOption(tabs[1].value);
  await page.waitForTimeout(1000);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(
    await page.getByRole('navigation', { name: '탐색 분류' }).locator('[aria-current="page"]').textContent(),
    tabs[1].label.replace('탐색 · ', ''),
  );
  await settings();
  await select().waitFor();
  await page.screenshot({ path: '/tmp/moya-startup-desktop.png' });
  await page.getByRole('tab', { name: /동기화/ }).click();
  await page.locator('.sync-panel-embedded').waitFor();
  assert.equal(await page.getByRole('dialog').count(), 1);
  assert.equal(await page.locator('.reader-settings-dialog').count(), 1);
  assert.equal(await page.locator('.sync-panel-embedded').count(), 1);
  await page.screenshot({ path: '/tmp/moya-sync-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: '/tmp/moya-sync-mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: '설정 목록' }).click();
  await page.getByRole('tab', { name: /모양/ }).click();
  await select().waitFor();
  await page.screenshot({ path: '/tmp/moya-startup-mobile.png' });
  // Restore legacy behavior, then verify the last shelf still works.
  await select().selectOption('last');
  await page.waitForTimeout(1000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await page.getByRole('navigation', { name: '사용자 책장' }).getByRole('button', { name: /Other/ }).click();
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(
    await page
      .getByRole('navigation', { name: '사용자 책장' })
      .getByRole('button', { name: /Other/ })
      .getAttribute('aria-current'),
    'page',
  );

  assert.deepEqual(errors, []);
  console.log(
    'PASS: remembered shelf overridden, all-books override, selected discovery tab after reload, inline sync, no browser errors',
  );
} finally {
  await browser.close();
  await server.close();
}
