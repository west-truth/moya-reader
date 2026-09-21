import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import DiscoveryScreen from '${root}src/features/discovery/DiscoveryScreen.tsx';
import {DiscoverySession} from '${root}src/features/discovery/discovery-session.ts';
${[...readFileSync(resolve(root, 'src/main.tsx'), 'utf8').matchAll(/import '\.\/styles\/([^']+)';/g)].map((match) => `import '${root}src/styles/${match[1]}';`).join('\n')}
const noop=()=>{};
const sources=['one','two'].map((id,i)=>({id,title:i?'두 번째 소스':'필터 소스',kind:'catalog',origin:'plugin',connection:{state:'connected'}}));
const filters=[{id:'genre',position:0,kind:'select',label:'장르',options:['전체','액션','판타지','로맨스'],defaultValue:0},{id:'day',position:1,kind:'select',label:'요일',options:['전체','월','화','수','목','금','토','일'],defaultValue:0}];
globalThis.calls=[];globalThis.failNext=false;globalThis.failRefresh=false;
const registry={getExternalSources:()=>sources.map(s=>({descriptor:{id:s.id,capabilities:['browse','search']}})),getExternalSourceStatus:()=>({state:'connected'}),async listExternalSource(id,context,input){
  calls.push({id,...input});await new Promise(r=>setTimeout(r,40));if(globalThis.failNext&&input.cursor){globalThis.failNext=false;throw new Error('잠시 연결이 끊겼습니다.');}
  if(globalThis.failRefresh && id==='one' && input.browseMode==='popular' && !input.cursor){globalThis.failRefresh=false;throw new Error('새 목록 조회 실패');}
  const start=input.cursor?18:0;return {items:Array.from({length:18},(_,i)=>({key:{connectorId:id,remoteId:String(start+i)},kind:'work',title:(input.browseMode==='search'?'검색 ':'작품 ')+(start+i+1),navigationRef:String(start+i),thumbnailUrl:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="280"><rect width="200" height="280" fill="'+(i%2?'#233b56':'#4b3548')+'"/><text x="25" y="140" fill="white" font-size="28">MOYA '+(start+i+1)+'</text></svg>')})),nextCursor:input.cursor?undefined:'next',browse:{activeMode:input.browseMode,availableModes:['popular','latest','search'],filters}};
}};
const session=new DiscoverySession(registry,{},'pinned-smoke');
const row=(id,sourceId,mode)=>({id,sourceId,title:'',mode});
const initial={version:1,tabs:[{id:'multi',title:'둘러보기',hidden:false,density:'comfortable',sections:[row('a','one','popular'),row('b','one','latest'),row('c','two','popular')]},{id:'single',title:'한 소스',hidden:false,density:'comfortable',sections:[row('d','two','popular')]}]};
const library={model:{query:'',filter:'all',sort:'recent',viewMode:'grid',sync:{label:'로컬',tone:'local'},externalSources:{active:false,busy:false,sources:[]},collection:{filterCounts:{all:0,reading:0,finished:0,unread:0,favorite:0,trash:0}},presentation:{shelfBookCounts:new Map()},management:{available:false,shelves:[],selectionMode:false,selectedBookIds:new Set(),busy:false}},actions:{presentation:{goHome:noop},controls:{setFilter:noop,setShelf:noop},books:{},header:{setQuery:noop,openImport:noop,openLibraryFolders:noop,openSync:noop,openBackup:noop,openSettings:noop,openExternalSource:noop,openExternalSourceSettings:noop}}};
function Fixture(){const [config,setConfig]=useState(()=>JSON.parse(localStorage.getItem('pinned-smoke')||'null')||initial);const [detail,setDetail]=useState(false);return detail?React.createElement('button',{onClick:()=>setDetail(false)},'상세 닫기'):React.createElement(DiscoveryScreen,{library,discovery:{config,scope:'pinned-smoke',session,save(next){localStorage.setItem('pinned-smoke',JSON.stringify(next));setConfig(next)}},sources:{sources,libraryWorks:[]},open:()=>setDetail(true)});}
document.documentElement.dataset.theme='dark';createRoot(document.getElementById('root')).render(React.createElement(Fixture));
`;
const result = await build({
  root,
  configFile: false,
  logLevel: 'error',
  plugins: [
    {
      name: 'fixture',
      resolveId: (id) => (id === 'fixture' ? '\0fixture' : undefined),
      load: (id) => (id === '\0fixture' ? source : undefined),
    },
  ],
  build: { write: false, rollupOptions: { input: 'fixture' } },
});
const output = result.output,
  entry = output.find((asset) => asset.isEntry);
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const asset = output.find((item) => '/' + item.fileName === path);
  response.setHeader(
    'Content-Type',
    asset ? (asset.type === 'chunk' ? 'application/javascript' : 'text/css') : 'text/html',
  );
  response.end(
    asset
      ? (asset.code ?? asset.source)
      : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
          output
            .filter((item) => item.fileName.endsWith('.css'))
            .map((item) => '<link rel="stylesheet" href="/' + item.fileName + '">')
            .join('') +
          '<div id="root"></div><script type="module" src="/' +
          entry.fileName +
          '"></script>',
  );
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.READER_UI_BROWSER_EXECUTABLE });
  for (const width of [390, 1366]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    const tabs = page.getByRole('navigation', { name: '탐색 분류' });
    const section = page.locator('[data-discovery-section="a"]');
    await section.getByRole('button', { name: '작품 1 상세 보기', exact: true }).waitFor();
    assert.equal(await section.locator('.discovery-card').count(), 12);
    await page.evaluate(() => {
      globalThis.failRefresh = true;
    });
    await section.getByRole('button', { name: /목록 새로고침$/ }).click();
    await section.getByRole('button', { name: /목록 다시 불러오기$/ }).waitFor();
    assert.equal(await section.locator('.discovery-card').count(), 12);
    assert.equal(await section.locator('.discovery-message, .discovery-inline-message').count(), 0);
    const heading = section.locator('.discovery-section-title');
    const titleBox = await heading.locator('h2').boundingBox();
    const refreshBox = await heading.locator('.discovery-refresh').boundingBox();
    assert(refreshBox.x > titleBox.x + titleBox.width);
    assert(Math.abs(refreshBox.y + refreshBox.height / 2 - (titleBox.y + titleBox.height / 2)) < 1);
    await section.getByRole('button', { name: /목록 다시 불러오기$/ }).click();
    await section.getByRole('button', { name: /목록 새로고침$/ }).waitFor();
    await section.getByRole('button', { name: '펼쳐 보기', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('[data-discovery-section="a"] .discovery-grid')?.children.length === 18,
    );
    await section.getByRole('button', { name: '더 불러오기', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('[data-discovery-section="a"] .discovery-grid')?.children.length === 36,
    );
    await section.getByRole('button', { name: '접기', exact: true }).last().click();
    await page.getByRole('button', { name: '빠른 이동', exact: true }).click();
    const jump = page.getByRole('dialog', { name: '소스 빠른 이동' });
    const pinButton = jump.getByRole('button', { name: '필터 소스 탭에 고정', exact: true });
    const pinBox = await pinButton.boundingBox();
    const pinIconBox = await pinButton.locator('svg').boundingBox();
    assert(Math.abs(pinBox.x + pinBox.width / 2 - (pinIconBox.x + pinIconBox.width / 2)) < 1);
    await pinButton.click();
    await jump.getByRole('button', { name: '빠른 이동 닫기', exact: true }).click();
    assert.equal(await tabs.getByRole('button', { name: '필터 소스', exact: true }).count(), 1);
    await page.locator('.discovery-source-view').getByText('상세 필터', { exact: true }).click();
    const before = await page.evaluate(() => calls.length);
    await page
      .getByRole('group', { name: '장르', exact: true })
      .getByRole('button', { name: '판타지', exact: true })
      .click();
    assert.equal(await page.evaluate(() => calls.length), before);
    await page.getByRole('button', { name: '적용', exact: true }).click();
    await page.getByRole('button', { name: '검색 1 상세 보기', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => calls.at(-1).filters[0].value), 2);
    await page.evaluate(() => {
      globalThis.failNext = true;
    });
    await page.getByRole('button', { name: '더 불러오기', exact: true }).click();
    await page.getByRole('button', { name: /목록 다시 불러오기$/ }).waitFor();
    assert.equal(await page.locator('.discovery-grid .discovery-card').count(), 18);
    assert.equal(
      await page
        .locator('.discovery-source-view .discovery-message, .discovery-source-view .discovery-inline-message')
        .count(),
      0,
    );
    assert.equal(await page.locator('.discovery-section-heading .discovery-refresh').count(), 1);
    await page.getByRole('button', { name: /목록 다시 불러오기$/ }).click();
    await page.waitForFunction(() => document.querySelector('.discovery-grid')?.children.length === 36);
    await tabs.getByRole('button', { name: '둘러보기', exact: true }).click();
    assert.equal(await page.locator('.discovery-section').count(), 3);
    await tabs.getByRole('button', { name: '필터 소스', exact: true }).click();
    const pinnedTab = tabs.getByRole('button', { name: '필터 소스', exact: true });
    const iconBox = await pinnedTab.locator('svg').boundingBox();
    const labelBox = await pinnedTab.locator('span').boundingBox();
    assert(Math.abs(iconBox.y + iconBox.height / 2 - (labelBox.y + labelBox.height / 2)) < 1);
    await page.waitForFunction(() => document.querySelector('.discovery-grid')?.children.length === 36);
    assert.equal(
      await page
        .getByRole('group', { name: '장르', exact: true })
        .getByRole('button', { name: '판타지', exact: true })
        .getAttribute('aria-pressed'),
      'true',
    );
    await page.locator('.discovery-body').evaluate((node) => {
      node.scrollTop = 500;
      node.dispatchEvent(new Event('wheel'));
      node.dispatchEvent(new Event('scroll'));
    });
    await page.locator('.discovery-grid .discovery-card').nth(10).click();
    await page.getByRole('button', { name: '상세 닫기' }).click();
    await page.waitForFunction(() => document.querySelector('.discovery-grid')?.children.length === 36);
    assert((await page.locator('.discovery-body').evaluate((node) => node.scrollTop)) > 200);
    await page.locator('.discovery-body').evaluate((node) => (node.scrollTop = 0));
    const searchButtons = page.locator('.discovery-source-view .discovery-search button');
    const searchBox = await searchButtons.nth(0).boundingBox();
    const resetBox = await searchButtons.nth(1).boundingBox();
    assert(searchBox.width >= 44 && resetBox.width >= 44);
    assert(searchBox.x + searchBox.width <= resetBox.x || searchBox.y + searchBox.height <= resetBox.y);
    await page.screenshot({ path: '/tmp/moya-discovery-pinned-' + width + '.png' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.reload();
    await tabs.getByRole('button', { name: '필터 소스', exact: true }).click();
    await page.locator('.discovery-source-view').waitFor();
    await tabs.getByRole('button', { name: '한 소스', exact: true }).click();
    await page.locator('.discovery-source-view h2').filter({ hasText: '두 번째 소스' }).waitFor();
    await page.getByRole('button', { name: '빠른 이동', exact: true }).click();
    await jump.getByRole('button', { name: '필터 소스 고정 해제', exact: true }).click();
    await jump.getByRole('button', { name: '빠른 이동 닫기', exact: true }).click();
    assert.equal(await tabs.getByRole('button', { name: '필터 소스', exact: true }).count(), 0);
    assert.equal(await tabs.getByRole('button', { name: '둘러보기', exact: true }).count(), 1);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Discovery pin/filter/expand/paging/error/reload/navigation checks passed at 390/1366px.');
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
