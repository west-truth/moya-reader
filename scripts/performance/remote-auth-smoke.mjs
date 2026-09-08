import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { build } from 'vite';
import { chromium } from 'playwright-core';

const entryId = 'virtual:remote-auth-smoke';
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteCollectorAuthBrowser } from '/src/features/extensions/RemoteCollectorAuthBrowser.tsx';
import '/src/styles/tokens.css';
import '/src/styles/base.css';
import '/src/styles/dialogs-import.css';
import '/src/features/reader-settings/reader-settings-panel.css';
let revision = 1;
let pageId = 'a'.repeat(32);
const tabs = [{ id: pageId, host: 'novel.example.test' }, { id: 'b'.repeat(32), host: 'login.example.test' }];
window.actions = [];
window.failNext = false;
const broker = {
  authBrowserFrame: async (after) => {
    if (after >= revision) return;
    return { revision, width: 390, height: 650, pageId, tabs, inputType: 'password', fields: [{x:20,y:80,width:350,height:45,type:'password'}],
      blob: new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="390" height="650"><rect width="390" height="650" fill="white"/><text x="20" y="45">Login fixture</text><rect x="20" y="80" width="350" height="45" fill="#eeeeee"/><rect x="20" y="140" width="350" height="45" fill="#eeeeee"/></svg>'], {type: 'image/svg+xml'}) };
  },
  authBrowserAction: async (action) => {
    window.actions.push(action);
    if (window.failNext) { window.failNext = false; throw new Error('Fixture input rejected'); }
    if (action.action === 'select_tab') pageId = action.pageId;
    revision++;
  }
};
createRoot(document.getElementById('root')).render(React.createElement(RemoteCollectorAuthBrowser, {
  broker, platformLabel: '테스트 플랫폼', busy: false,
  onComplete: () => { window.completed = true; }, onCancel: () => {}, onDismiss: () => {}
}));
`;
const bundle = await build({
  configFile: false,
  logLevel: 'error',
  plugins: [
    {
      name: 'auth-fixture',
      resolveId: (id) => (id === entryId ? entryId : undefined),
      load: (id) => (id === entryId ? fixture : undefined),
    },
  ],
  build: { write: false, rollupOptions: { input: entryId } },
});
const assets = new Map(bundle.output.map((asset) => [`/${asset.fileName}`, asset]));
const entry = bundle.output.find((a) => a.type === 'chunk' && a.isEntry);
const css = bundle.output.filter((a) => a.fileName.endsWith('.css'));
const html = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">${css.map((a) => `<link rel="stylesheet" href="/${a.fileName}">`).join('')}<div id="root"></div><script type="module" src="/${entry.fileName}"></script>`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext({ hasTouch: true });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://auth-fixture.test') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    const asset = assets.get(url.pathname);
    return route.fulfill({
      status: asset ? 200 : 404,
      contentType: asset?.type === 'chunk' ? 'application/javascript' : 'text/css',
      body: asset?.type === 'chunk' ? asset.code : asset ? Buffer.from(asset.source) : '',
    });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('https://auth-fixture.test');
  const input = page.getByLabel('선택한 로그인 입력칸에 입력');
  await page.getByLabel('로그인 창 선택').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const remoteFrame = page.locator('.collector-auth-browser-frame');
  const remoteBounds = await remoteFrame.boundingBox();
  await remoteFrame.tap({ position: { x: (remoteBounds.width * 50) / 390, y: (remoteBounds.height * 100) / 650 } });
  assert.equal(await input.evaluate((element) => document.activeElement === element), true);
  await mkdir('.tmp', { recursive: true });
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
    [320, 640],
    [390, 440],
  ]) {
    await page.setViewportSize({ width, height });
    await input.click();
    await input.fill('합성 입력');
    const bounds = await input.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.getByRole('button', { name: '입력', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input').value === '');
    assert.equal((await page.evaluate(() => window.actions.at(-1))).text, '합성 입력');
    await page.screenshot({ path: '.tmp/remote-auth-' + width + '-' + height + '.png' });
  }
  await page.evaluate(() => {
    window.failNext = true;
  });
  await input.fill('retry-input');
  await page.getByRole('button', { name: '입력', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await input.inputValue(), 'retry-input');
  await page.getByRole('button', { name: '입력', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input').value === '');
  await page.getByLabel('로그인 창 선택').selectOption('b'.repeat(32));
  await page.waitForFunction(() => document.querySelector('select').value === 'b'.repeat(32));
  await input.click();
  await input.fill('new-window');
  await page.getByRole('button', { name: '입력', exact: true }).click();
  await page.waitForFunction(() => window.actions.at(-1)?.text === 'new-window');
  assert.equal((await page.evaluate(() => window.actions.at(-1))).pageId, 'b'.repeat(32));
  await page.getByRole('button', { name: '로그인 완료', exact: true }).click();
  await page.waitForFunction(() => window.completed === true);
  assert.deepEqual(errors, []);
  console.log(
    'Remote auth UI passed: desktop/mobile/keyboard viewport, editable input, retry retention, tab-bound actions, completion.',
  );
} finally {
  await browser.close();
}
