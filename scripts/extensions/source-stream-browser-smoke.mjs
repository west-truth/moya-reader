import { build } from 'vite';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const root = process.cwd();
await mkdir(root + '/.tmp/source-stream-review', { recursive: true });
const require = createRequire(root + '/apps/server/package.json');
const png = await require('sharp')({ create: { width: 600, height: 900, channels: 3, background: '#496885' } })
  .png()
  .toBuffer();
const code = `import React from 'react';import {createRoot} from 'react-dom/client';import {SourceStreamReader} from '${root}/src/features/external-sources/SourceStreamReader.tsx';import '${root}/src/styles/external-sources.css';
globalThis.calls=[];globalThis.saves=0;globalThis.closedStreams=0;globalThis.opens=0;globalThis.rejectSave=false;globalThis.expireNext=false;
const params=new URLSearchParams(location.search);localStorage.setItem('moya.source-reading.v1',JSON.stringify({mode:params.get('mode'),prefetch:Number(params.get('prefetch')??4)}));
const failed=new Set();
const port={open:async()=>{opens++;return {pageCount:30,close(){globalThis.closedStreams++},loadPage:async(index,signal)=>{calls.push(index);if(globalThis.expireNext){globalThis.expireNext=false;throw new Error('source_stream_expired');}if(index===5&&!failed.has(5)){failed.add(5);throw new Error('연결을 확인해 주세요.');}const response=await fetch('/image',{signal});return response.blob();}}}};
function Fixture(){const [episode,setEpisode]=React.useState(1);return React.createElement(SourceStreamReader,{title:'검증용 만화 '+episode+'화',remoteId:'fixture-'+episode,port,onClose:()=>globalThis.closedStreams++,onSave:async()=>{saves++;if(globalThis.rejectSave)throw new Error('다른 탭에서 다운로드 중입니다.');},onCancelSave:()=>{},previous:episode>1?async(isCurrent=()=>true)=>{if(isCurrent())setEpisode(n=>n-1)}:undefined,next:async(isCurrent=()=>true)=>{if(isCurrent())setEpisode(n=>n+1)}})}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));`;
const result = await build({
  root,
  configFile: false,
  logLevel: 'error',
  plugins: [
    {
      name: 'fixture',
      resolveId: (id) => (id === 'fixture' ? '\0fixture.tsx' : undefined),
      load: (id) => (id === '\0fixture.tsx' ? code : undefined),
    },
  ],
  esbuild: { jsx: 'automatic' },
  build: { write: false, rollupOptions: { input: 'fixture' } },
});
const output = result.output,
  entry = output.find((x) => x.isEntry);
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://local').pathname;
  if (path === '/image') {
    res.setHeader('Content-Type', 'image/png');
    res.end(png);
    return;
  }
  const asset = output.find((x) => '/' + x.fileName === path);
  if (asset) {
    res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.end(asset.code ?? asset.source);
    return;
  }
  res.end(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font-family:sans-serif}button{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;background:#303030;color:white;padding:8px;border:1px solid #777;border-radius:8px}button:disabled{opacity:.5}.icon-btn{min-width:44px}.modal-backdrop{position:fixed;inset:0;z-index:999;background:#0009;display:grid;place-items:center}.modal{background:#222;color:white;padding:16px;max-height:95vh;overflow:auto;box-sizing:border-box}.modal input{max-width:100%}</style>' +
      output
        .filter((x) => x.fileName.endsWith('.css'))
        .map((x) => '<link rel="stylesheet" href="/' + x.fileName + '">')
        .join('') +
      '<div id="root"></div><script type="module" src="/' +
      entry.fileName +
      '"></script>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  headless: true,
  args: ['--no-sandbox'],
});
try {
  for (const [mode, width, prefetch = 4] of [
    ['stream-save', 390],
    ['stream', 390],
    ['stream', 1280],
    ['stream', 390, 0],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } }),
      errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', (e) => {
      errors.push(e.message);
      console.log('pageerror', e.message);
    });
    await page.goto('http://127.0.0.1:' + server.address().port + '/?mode=' + mode + '&prefetch=' + prefetch);
    await page
      .waitForFunction(() => document.querySelector('img')?.naturalWidth > 0, {}, { timeout: 10000 })
      .catch(async (e) => {
        console.log(await page.locator('body').innerText());
        throw e;
      });
    await page.waitForTimeout(150);
    const first = await page.evaluate(() => ({
      calls: [...calls],
      saves,
      width: document.documentElement.scrollWidth,
    }));
    assert(first.calls.length <= 5, JSON.stringify(first));
    assert.equal(first.saves, mode === 'stream-save' ? 1 : 0);
    assert(first.width <= width);
    await page.screenshot({ path: root + '/.tmp/source-stream-review/' + mode + '-' + width + '.png' });
    await page.locator('article[data-page-index="5"]').scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '다시 불러오기' }).click();
    await page.waitForFunction(() => document.querySelector('article[data-page-index="5"] img')?.naturalWidth > 0);
    await page.locator('article[data-page-index="29"]').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('article[data-page-index="29"] img')?.naturalWidth > 0);
    // Reopening a no-save episode restores the page and within-image offset.
    await page.evaluate(() => {
      const root = document.querySelector('.source-stream-viewport'),
        row = document.querySelector('article[data-page-index="24"]');
      root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top + 120;
    });
    await page.waitForFunction(() => document.querySelector('article[data-page-index="24"] img')?.naturalWidth > 0);
    await page.waitForTimeout(350);
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('moya.source-stream-positions.v1')));
    assert.equal(history.at(-1)[1].page, 24);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('article[data-page-index="24"] img')?.naturalWidth > 0);
    await page.waitForTimeout(200);
    const resumed = await page.evaluate(() => {
      const row = document.querySelector('article[data-page-index="24"]'),
        root = document.querySelector('.source-stream-viewport');
      return root.getBoundingClientRect().top - row.getBoundingClientRect().top;
    });
    assert(Math.abs(resumed - 120) < 5, 'restored offset: ' + resumed);
    assert.equal(await page.locator('.source-stream-toolbar').isVisible(), false);
    // Central tap reveals controls and leaves them visible until another explicit tap.
    await page.locator('.source-stream-viewport').click({ position: { x: width / 2, y: 250 } });
    assert.equal(await page.locator('.source-stream-toolbar').isVisible(), true);
    if (mode === 'stream') {
      await page.evaluate(() => {
        globalThis.rejectSave = true;
      });
      await page.getByRole('button', { name: '회차 저장', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '다른 탭' }).waitFor();
      assert.equal(await page.getByRole('button', { name: '회차 저장', exact: true }).isEnabled(), true);
      await page.evaluate(() => {
        globalThis.rejectSave = false;
      });
    }
    // Existing comic auto-reading settings, pause/resume dock, and immersive mode are reused.
    await page.getByRole('button', { name: '자동 읽기', exact: true }).click();
    await page.getByLabel('항상 오버레이 표시').check();
    await page.getByRole('button', { name: '시작', exact: true }).click();
    await page.getByRole('button', { name: '자동 읽기 일시정지' }).waitFor();
    await page.locator('.source-stream-toolbar').waitFor({ state: 'hidden' });
    const scrollBefore = await page.locator('.source-stream-viewport').evaluate((e) => e.scrollTop);
    await page.waitForTimeout(400);
    assert((await page.locator('.source-stream-viewport').evaluate((e) => e.scrollTop)) > scrollBefore);
    await page.getByRole('button', { name: '자동 읽기 일시정지' }).click();
    await page.getByRole('button', { name: '자동 읽기 재개' }).waitFor();
    const room = await page.evaluate(() => ({
      bottom: document.querySelector('.source-stream-viewport').getBoundingClientRect().bottom,
      dock: document.querySelector('.reader-auto-scroll-dock').getBoundingClientRect().top,
    }));
    assert(room.bottom <= room.dock, JSON.stringify(room));
    await page.getByRole('button', { name: '다음 회차', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('main')?.getAttribute('aria-label') === '검증용 만화 2화 바로 읽기',
    );
    await page.waitForFunction(() => document.querySelector('article[data-page-index="0"] img')?.naturalWidth > 0);
    const previousPage = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('moya.source-stream-positions.v1')).find(([id]) => id === 'fixture-1')[1].page,
    );
    await page.getByRole('button', { name: '이전 회차', exact: true }).click();
    await page.waitForFunction(
      (index) => document.querySelector(`article[data-page-index="${index}"] img`)?.naturalWidth > 0,
      previousPage,
    );
    // An expired host session can reopen without losing the last successfully viewed page.
    await page.evaluate(() => {
      globalThis.expireNext = true;
    });
    await page.locator('article[data-page-index="2"]').scrollIntoViewIfNeeded();
    const retryPage = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('moya.source-stream-positions.v1')).find(([id]) => id === 'fixture-1')[1].page,
    );
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await page
      .waitForFunction(
        (index) => document.querySelector(`article[data-page-index="${index}"] img`)?.naturalWidth > 0,
        retryPage,
      )
      .catch(async (error) => {
        console.log(
          'expiry',
          retryPage,
          await page.evaluate(() => ({
            current: document.querySelector('main').dataset,
            history: localStorage.getItem('moya.source-stream-positions.v1'),
            calls,
            body: document.body.innerText,
            scroll: document.querySelector('.source-stream-viewport').scrollTop,
          })),
        );
        throw error;
      });
    // Continue automatically into the next episode using the same shared controller.
    if (!(await page.locator('.source-stream-toolbar').isVisible()))
      await page.locator('.source-stream-viewport').click({ position: { x: width / 2, y: 250 } });
    await page.getByRole('button', { name: '자동 읽기', exact: true }).click();
    await page.getByLabel('회차 끝에서 다음 회차로 이동').check();
    await page.getByRole('button', { name: '시작', exact: true }).click();
    await page.getByRole('button', { name: '자동 읽기 일시정지' }).waitFor();
    await page.locator('.source-stream-viewport').evaluate((root) => {
      root.scrollTop = root.scrollHeight - root.clientHeight - 92;
    });
    await page
      .waitForFunction(
        () => document.querySelector('main')?.getAttribute('aria-label') === '검증용 만화 2화 바로 읽기',
        {},
        { timeout: 10000 },
      )
      .catch(async (error) => {
        console.log(
          await page.evaluate(() => ({
            body: document.body.innerText,
            scroll: document.querySelector('.source-stream-viewport').scrollTop,
            height: document.querySelector('.source-stream-viewport').clientHeight,
            total: document.querySelector('.source-stream-viewport').scrollHeight,
            last: document.querySelector('article[data-page-index="29"]').getBoundingClientRect().toJSON(),
            requests: calls,
            current: document.querySelector('main').dataset,
          })),
        );
        throw error;
      });
    await page.getByRole('button', { name: '자동 읽기 일시정지' }).waitFor();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mode, width, prefetch, initial: first, passed: true }));
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
