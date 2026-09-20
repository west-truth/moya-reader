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
import {ReaderQuickViewDialog} from '${root}src/features/reader/ReaderQuickViewDialog.tsx';
import {SettingsSlider} from '${root}src/features/reader-settings/SettingsSlider.tsx';
import '${root}src/features/fixed-document/fixed-document.css';
import ReaderSettingsPanel from '${root}src/features/reader-settings/ReaderSettingsPanel.tsx';
import {DEFAULT_READING_PROFILE,DEFAULT_GESTURE_BINDINGS} from '${root}src/features/reader-settings/reading-profile.ts';
import {defaultSettings} from '${root}src/repositories/reader-defaults.ts';
${[...readFileSync(resolve(root, 'src/main.tsx'), 'utf8').matchAll(/import '\.\/styles\/([^']+)';/g)].map((match) => `import '${root}src/styles/${match[1]}';`).join('\n')}
const noop=()=>{};
const externalSources={sources:Array.from({length:8},(_,i)=>({id:'fixture-'+i,title:'검증용 소스 '+i,origin:'plugin',contentKind:'text',lang:'ko',description:'연결한 소스에서 작품을 탐색합니다.',connection:{state:'connected'}})),selectSource:noop,show:noop,recoverableDownloads:[],downloadRetention:{enabled:false,keep:5,busy:false,error:'',setEnabled:noop,setKeep:noop,inspect:noop,clean:noop}};
function Fixture(){const [profile,setProfile]=useState(DEFAULT_READING_PROFILE);const [open,setOpen]=useState(true);globalThis.changes??=[];const update=p=>{changes.push(p);setProfile(x=>({...x,...p}));};
if(new URLSearchParams(location.search).has('controls')) return React.createElement('div',{},
React.createElement('div',{className:'fixed-doc-comic-settings',style:{width:280}},React.createElement('fieldset',{},React.createElement(SettingsSlider,{label:'만화 밝기',min:40,max:180,step:1,value:100,onChange:noop}))),
React.createElement('div',{className:'tts-playback-setting-grid',style:{width:260}},React.createElement(SettingsSlider,{label:'듣기 속도',min:0.6,max:1.8,step:0.1,value:1,onChange:noop})));
return new URLSearchParams(location.search).has('full')?React.createElement(ReaderSettingsPanel,{controller:{open,settings:defaultSettings,closePanel:()=>setOpen(false),saveStatus:'idle',updateSettings:noop},profile,bookOverrideEnabled:false,contrastWarning:false,gestureBindings:DEFAULT_GESTURE_BINDINGS,platformRuntime:{kind:'browser',hasTauri:false},providerExecutionRuntime:'none',extensions:[],externalSources,openSync:noop,openBackup:noop,updateProfile:update,setBookOverrideEnabled:noop,resetProfile:noop,updateGestureBindings:noop,setExtensionEnabled:noop}):React.createElement(ReaderQuickViewDialog,{open,profile,readingFlow:'paginated',bookOverrideEnabled:false,onClose:()=>setOpen(false),onUpdate:update,onSetBookOverride:noop,onOpenAllSettings:noop});}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
`;
const result = await build({
  root,
  configFile: false,
  logLevel: 'error',
  plugins: [
    {
      name: 'settings-fixture',
      resolveId: (id) => (id === 'settings-fixture' ? '\0settings-fixture' : undefined),
      load: (id) => (id === '\0settings-fixture' ? source : undefined),
    },
  ],
  build: { write: false, rollupOptions: { input: 'settings-fixture' } },
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [width, height] of [
    [360, 640],
    [390, 844],
    [1366, 768],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(base);
    const end = page.getByRole('button', { name: '글꼴·색상·조판 전체 설정' });
    await end.scrollIntoViewIfNeeded();
    const box = await end.boundingBox();
    assert(box.y >= 0 && box.y + box.height <= height, `Quick view end clipped at ${width}`);
    assert.equal(await page.getByRole('slider').count(), 2);
    await page.getByLabel('글자 크기 직접 입력').fill('');
    await page.getByLabel('줄 간격 직접 입력').click();
    assert.deepEqual(await page.evaluate(() => globalThis.changes), []);
    await page.goto(base + '?full');
    await page.getByRole('tab', { name: /^리더 보기/ }).click();
    await page.getByRole('heading', { name: '리더 보기', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
    if (width < 700) {
      assert.equal(await page.getByRole('tab', { name: /^동기화/ }).count(), 0);
      await page.getByRole('button', { name: '설정 목록' }).click();
      await page.waitForFunction(() => document.activeElement?.id === 'reader-settings-tab-layout');
      await page.getByRole('tab', { name: /^리더 조작/ }).click();
      assert.equal(await page.getByText('이 책에만 적용', { exact: true }).count(), 0);
      await page.keyboard.press('Escape');
      await page.getByRole('tab', { name: /^동기화/ }).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog').count(), 0);
    }
  }
  await page.setViewportSize({ width: 360, height: 640 });
  for (const theme of ['dark', 'light']) {
    await page.goto(base + '?full');
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    assert.equal(await page.getByRole('tab', { name: /^다운로드/ }).count(), 0);
    await page.getByRole('tab', { name: /^콘텐츠 소스/ }).click();
    const header = page.locator('.reader-settings-page-title');
    assert.equal(await header.evaluate((node) => getComputedStyle(node).position), 'static');
    const before = await header.boundingBox();
    await page.locator('.reader-settings-content').evaluate((node) => (node.scrollTop = 400));
    const after = await header.boundingBox();
    assert(after.y < before.y - 350, 'Settings description did not scroll with content');
    const favorite = page.getByRole('button', { name: '검증용 소스 0 즐겨찾기' });
    await favorite.scrollIntoViewIfNeeded();
    assert.equal(await favorite.evaluate((node) => getComputedStyle(node).borderRadius), '10px');
    const nextPressed = (await favorite.getAttribute('aria-pressed')) !== 'true';
    await favorite.click();
    await page.waitForFunction(
      ({ label, pressed }) =>
        document.querySelector(`[aria-label="${label}"]`)?.getAttribute('aria-pressed') === String(pressed),
      { label: '검증용 소스 0 즐겨찾기', pressed: nextPressed },
    );
    await page.screenshot({ path: `/tmp/moya-settings-sources-${theme}.png` });
    await page.getByRole('button', { name: '다운로드 및 저장공간' }).click();
    await page.getByRole('heading', { name: '읽은 회차 정리', exact: true }).waitFor();
    assert.equal(await page.getByRole('checkbox', { name: /리더를 나온 뒤 자동 정리/ }).isChecked(), false);
    await page.screenshot({ path: `/tmp/moya-settings-downloads-${theme}.png` });
    await page.getByRole('button', { name: '콘텐츠 소스', exact: true }).click();
    await page.getByRole('button', { name: '다운로드 및 저장공간' }).waitFor();
  }
  await page.goto(base + '?controls');
  await page.getByRole('slider', { name: '만화 밝기' }).waitFor();
  assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
  for (const control of await page.locator('.reader-settings-slider-controls').all()) {
    assert.equal(await control.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  }
  assert.deepEqual(errors, []);
  console.log(
    'Settings UX passed: 360/390/1366px, quick-view scroll/AX/empty input, mobile categories/back/focus/scope.',
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
