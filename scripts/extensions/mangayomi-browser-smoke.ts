import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { build } = require('esbuild') as typeof import('../../apps/server/node_modules/esbuild');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, '.tmp', `mangayomi-browser-${Date.now()}`);
await mkdir(output, { recursive: true });
await build({
  stdin: {
    contents: `
 import React from 'react'; import {createRoot} from 'react-dom/client';
 import {ApkExtensionsPanel} from './src/features/extensions/ApkExtensionsPanel';
 import './src/styles/tokens.css'; import './src/styles/base.css'; import './src/features/reader-settings/reader-settings-panel.css';
 const snapshot={available:true,revision:0,packages:[],repositories:[]};
 const entries=Array.from({length:27},(_,i)=>({pkg:'org.example.manga'+i,name:i===0?'이미지 소설 확장':'긴 이름 만화 확장 '+i,code:1,version:'1.4.1',sources:[],lang:'ko',apk:'manga.apk',nsfw:true,excludedSources:0}));
 let keySaved=false; const manager={preferences:async()=>({revision:snapshot.revision,privateOrigins:[],fields:[{key:'key',title:'Access key',kind:'text',secret:true,configured:keySaved},{key:'enabled',title:'Enable provider',kind:'boolean',secret:false,value:false},{key:'endpoint',title:'Provider URL',kind:'text',secret:false,value:''}]}),savePreferences:async()=>{keySaved=true;snapshot.revision++;},list:async()=>structuredClone(snapshot),refreshRepository:async url=>{if(!snapshot.repositories.some(r=>r.url===url))snapshot.repositories.push({url,updatedAt:Date.now(),entries});},
 removeRepository:async url=>{snapshot.repositories=snapshot.repositories.filter(r=>r.url!==url)},
 inspectRepository:async(url,pkg,code)=>({id:pkg,revision:snapshot.revision,digest:'a'.repeat(64),pkg,code,version:'1.4.1',signers:[],format:'mangayomi-js',origin:'https://first.example'}),
 install:async review=>{snapshot.packages.push({...review,enabled:true,sources:[{id:'123',name:'이미지 소설 확장',lang:'ko'}]});snapshot.revision++;},
 change:async(pkg,revision,action)=>{if(revision!==snapshot.revision)throw Error('apk_install_conflict');if(action==='remove')snapshot.packages=snapshot.packages.filter(p=>p.pkg!==pkg);else snapshot.packages.find(p=>p.pkg===pkg).enabled=action==='enable';snapshot.revision++;}};
 createRoot(document.getElementById('root')).render(<main style={{maxWidth:720,margin:'20px auto',padding:16}}><ApkExtensionsPanel manager={manager} format="mangayomi-js"/></main>);
`,
    resolveDir: root,
    loader: 'tsx',
    sourcefile: 'apk-ui.tsx',
  },
  bundle: true,
  outfile: resolve(output, 'fixture.js'),
  jsx: 'automatic',
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});
const server = createServer(async (request, response) => {
  if (request.url === '/fixture.js' || request.url === '/fixture.css') {
    response.setHeader('Content-Type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(resolve(output, request.url.slice(1))));
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end(
    '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>',
  );
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
if (!address || typeof address === 'string') throw Error('listen');
const browser = await chromium.launch({
  channel: process.env.READER_UI_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  const panel = page.getByRole('region', { name: 'Mangayomi JS 확장 관리' });
  for (const url of ['https://first.example/index.min.json', 'https://second.example/index.min.json']) {
    await panel.getByLabel('Mangayomi JS 저장소 주소').fill(url);
    await panel.getByRole('button', { name: '저장소 추가', exact: true }).click();
    await panel.getByRole('option', { name: new URL(url).hostname, exact: true }).waitFor({ state: 'attached' });
  }
  assert.equal(await panel.locator('.installed-extension-list > article').count(), 20);
  await panel.getByRole('button', { name: '다음', exact: true }).click();
  assert.equal(await panel.locator('.installed-extension-list > article').count(), 7);
  await panel.getByRole('button', { name: '이전', exact: true }).click();
  await panel.getByLabel('Mangayomi JS 확장 검색').fill('이미지 소설');
  await panel.getByRole('button', { name: '설치 검토', exact: true }).click();
  const review = panel.getByRole('article', { name: 'Mangayomi JS 설치 검토' });
  assert(await review.getByRole('button', { name: '설치', exact: true }).isDisabled());
  for (const width of [390, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: resolve(output, `review-${width}.png`), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow ${width}`);
  }
  await review.getByLabel('신뢰하는 확장입니다').check();
  await review.getByRole('button', { name: '설치', exact: true }).click();
  await panel.getByRole('button', { name: '설치됨 1', exact: true }).click();
  await panel.getByRole('button', { name: '끄기', exact: true }).click();
  await panel.getByRole('button', { name: '켜기', exact: true }).waitFor();
  await panel.getByRole('button', { name: '켜기', exact: true }).click();
  await panel.getByRole('button', { name: '끄기', exact: true }).waitFor();
  await panel.locator('.installed-extension-list button[aria-expanded]').click();
  await panel.getByLabel('Access key', { exact: true }).fill('fixture-secret');
  await panel.getByLabel('Provider URL', { exact: true }).fill('http://192.168.1.20:8080');
  await panel.locator('.compatibility-preferences details summary').click();
  for (const width of [390, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: resolve(output, `options-${width}.png`), fullPage: true });
  }
  await panel.locator('.compatibility-preferences button[type=submit]').click();
  await page.waitForFunction(
    () => document.querySelector<HTMLInputElement>('.compatibility-preferences input[type=password]')?.value === '',
  );
  await panel.getByRole('button', { name: '확장 제거', exact: true }).click();
  await panel.getByText('표시할 확장이 없습니다.').waitFor();
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ status: 'pass', widths: [390, 768, 1024], errors }));
  console.log('PASS Mangayomi JS settings browser: ' + output);
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
