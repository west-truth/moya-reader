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
globalThis.calls=[];globalThis.saves=0;globalThis.closedStreams=0;
const params=new URLSearchParams(location.search);localStorage.setItem('moya.source-reading.v1',JSON.stringify({mode:params.get('mode'),prefetch:4}));
const failed=new Set();
const port={open:async()=>({pageCount:30,close(){globalThis.closedStreams++},loadPage:async(index,signal)=>{calls.push(index);if(index===5&&!failed.has(5)){failed.add(5);throw new Error('연결을 확인해 주세요.');}const response=await fetch('/image',{signal});return response.blob();}})};
createRoot(document.getElementById('root')).render(React.createElement(SourceStreamReader,{title:'검증용 만화 1화',remoteId:'fixture',port,onClose:()=>globalThis.closedStreams++,onSave:async()=>{saves++},onCancelSave:()=>{},next:()=>{}}));`;
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
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:sans-serif}button{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;background:#303030;color:white;padding:8px;border:1px solid #777;border-radius:8px}button:disabled{opacity:.5}.icon-btn{min-width:44px}</style>' +
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
  for (const [mode, width] of [
    ['stream-save', 390],
    ['stream', 390],
    ['stream', 1280],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } }),
      errors = [];
    page.on('pageerror', (e) => {
      errors.push(e.message);
      console.log('pageerror', e.message);
    });
    await page.goto('http://127.0.0.1:' + server.address().port + '/?mode=' + mode);
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
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mode, width, initial: first, passed: true }));
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
