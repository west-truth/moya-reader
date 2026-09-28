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
const code = `import React from 'react';import {createRoot} from 'react-dom/client';import {SourceStreamReader} from '${root}/src/features/external-sources/SourceStreamReader.tsx';
import {IndexedDbComicReadingProfileRepository} from '${root}/src/storage/comic-reading-profile-store.ts';
import {savedFirstSourceStream} from '${root}/src/external-sources/saved-source-stream.ts';
import {useSourceStreamNavigation} from '${root}/src/features/external-sources/use-source-stream-navigation.ts';
import {openReaderDb} from '${root}/src/storage/reader-database.ts';
globalThis.thumbnailCount=async()=>{const db=await openReaderDb();return new Promise((resolve,reject)=>{const request=db.transaction('document_thumbnail_cache','readonly').objectStore('document_thumbnail_cache').count();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});};
import {saveSourceStreamPosition} from '${root}/src/external-sources/source-stream-history.ts';
import {DEFAULT_COMIC_READING_PROFILE} from '${root}/src/features/fixed-document/comic-layout.ts';
import '${root}/src/styles/tokens.css';import '${root}/src/styles/base.css';import '${root}/src/styles/dialogs-import.css';import '${root}/src/styles/shell.css';import '${root}/src/styles/library.css';
globalThis.positionWrites=[];globalThis.calls=[];globalThis.saves=[];globalThis.closedStreams=0;globalThis.opens=[];globalThis.expireNext=false;globalThis.retryPage=false;globalThis.repairCorrupt=false;
const params=new URLSearchParams(location.search);localStorage.setItem('moya.source-reading.v1',JSON.stringify({mode:params.get('mode'),prefetch:Number(params.get('prefetch')??8)}));
const failed=new Set();
const remotePort={open:async(id)=>{opens.push(id);return {pageCount:30,close(){globalThis.closedStreams++},loadPage:async(index,signal)=>{calls.push([id,index]);if(globalThis.expireNext){globalThis.expireNext=false;throw new Error('source_stream_expired');}if(index===5&&!globalThis.retryPage){throw new Error('연결을 확인해 주세요.');}if(index===6&&!globalThis.repairCorrupt)return new Blob(['broken image'],{type:'image/png'});return (await fetch('/image',{signal})).blob();}}}};
globalThis.savedEpisodes=[];globalThis.savedReads=[];globalThis.remoteOpens=[];
const originalOpen=remotePort.open;remotePort.open=async(id,signal)=>{remoteOpens.push(id);return originalOpen(id,signal)};
const port=savedFirstSourceStream(remotePort,{
 find:async(id)=>{if(!savedEpisodes.includes(Number(id.split('-')[1])))return undefined;opens.push(id);return {novel:{id:'saved-book',format:'image_archive'},sectionId:id,chapters:Array.from({length:30},(_,i)=>({id:id+':'+i,index:i,documentSectionId:id}))}},
 getParagraphPage:async(id)=>({paragraphs:[{assetId:id}]}),
 assets:{getEmbeddedResource:async(_,id,signal)=>{const [episode,index]=id.split(':');calls.push([episode,Number(index)]);savedReads.push(episode);return {blob:await(await fetch('/image',{signal})).blob()}}}
});
saveSourceStreamPosition('fixture-2',{page:15,fraction:0.5,ratio:1.5,count:30});
function Fixture(){
 const [episode,setEpisode]=React.useState(1);
 const [saved,setSaved]=React.useState(params.get('mixed')==='true'?[2]:[]);
 globalThis.episode=episode;globalThis.savedEpisodes=saved;
 const save=async(n)=>{saves.push(n);setSaved(value=>[...value,n]);};
 const items=Array.from({length:4},(_,i)=>({key:{connectorId:'fixture',remoteId:'fixture-'+(i+1)},title:(i+1)+'화',release:{title:(i+1)+'화',sourceOrder:i+1},importState:saved.includes(i+1)?'imported':'available'}));
 const nav=useSourceStreamNavigation({streaming:{item:items[episode-1]},items,openStreamItem:async item=>setEpisode(Number(item.key.remoteId.split('-')[1])),openImported:async()=>{throw Error('viewer must stay mounted')},closeStream:()=>{throw Error('viewer must stay mounted')}});
 return React.createElement(SourceStreamReader,{title:'검증용 만화 '+episode+'화',remoteId:'fixture-'+episode,profileKey:'fixture-'+episode,fromStart:episode>1,port,saved:saved.includes(episode),onClose:()=>globalThis.closedStreams++,onSave:()=>save(episode),onPageSettled:(page)=>positionWrites.push([episode,page]),previous:nav.previous,next:nav.next,navigationBusy:nav.busy,nextEpisode:episode<4?{remoteId:'fixture-'+(episode+1),title:(episode+1)+'화',saved:saved.includes(episode+1),busy:false,save:()=>save(episode+1)}:undefined});
}
void new IndexedDbComicReadingProfileRepository().save('fixture',{...DEFAULT_COMIC_READING_PROFILE,mode:params.get('view')||'vertical',seamlessVertical:true,fit:'width',pageTurnMotion:'instant'}).then(()=>createRoot(document.getElementById('root')).render(React.createElement(Fixture)));`;
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
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
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
async function reveal(page) {
  if (await page.locator('.fixed-doc-screen.is-immersive').count()) {
    const box = await page.locator('.fixed-doc-viewport').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 5);
  }
  await page.locator('.fixed-doc-footer').waitFor({ state: 'visible' });
}
try {
  for (const [mode, width, view, prefetch, mixed = false] of [
    ['stream-save', 390, 'vertical', 8],
    ['stream', 390, 'vertical', 8],
    ['stream', 1280, 'single', 8],
    ['stream', 1280, 'spread', 0],
    ['stream', 390, 'vertical', 8, true],
    ['stream', 1280, 'spread', 8, true],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } }),
      errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(
      `http://127.0.0.1:${server.address().port}/?mode=${mode}&view=${view}&prefetch=${prefetch}&mixed=${mixed}`,
    );
    await page.waitForFunction(() => document.querySelector('.fixed-doc-pages img')?.naturalWidth > 0);
    if (width >= 1280) {
      await page.waitForFunction(() => document.querySelector('.fixed-doc-sidebar img')?.naturalWidth > 0);
      assert.equal(
        await page.evaluate(() => thumbnailCount()),
        0,
        'Transient episode thumbnails must not leave orphaned library cache rows',
      );
      assert.equal(await page.getByRole('button', { name: '전체 준비', exact: true }).count(), 0);
    }
    assert.equal(await page.locator('.source-stream-toolbar').count(), 0);
    assert.equal(await page.getByRole('button', { name: '저장 취소', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '회차 저장', exact: true }).count(), 0);
    if (prefetch) {
      // First warm-up encounters a deliberate failure at page 5; pages 0..4 stay reusable.
      await page.waitForFunction(() => calls.some(([id, index]) => id === 'fixture-2' && index === 4));
      assert.equal(await page.evaluate(() => opens.filter((id) => id === 'fixture-2').length), 1);
    }
    if (mode === 'stream-save') await page.waitForFunction(() => saves.includes(1) && saves.includes(2));
    else assert.deepEqual(await page.evaluate(() => saves), []);
    assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= width);
    await page.screenshot({ path: root + `/.tmp/source-stream-review/shared-${view}-${mode}-${width}.png` });
    if (view === 'vertical') {
      await page.locator('article[data-page-index="5"]').scrollIntoViewIfNeeded();
      await page.getByText('연결을 확인해 주세요.', { exact: true }).waitFor();
      await page.getByRole('button', { name: '6페이지 다시 불러오기', exact: true }).evaluate((button) =>
        button.addEventListener(
          'click',
          () => {
            globalThis.retryPage = true;
          },
          { once: true, capture: true },
        ),
      );
      await page.getByRole('button', { name: '6페이지 다시 불러오기', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('article[data-page-index="5"] img')?.naturalWidth > 0);
      await page.locator('article[data-page-index="6"]').scrollIntoViewIfNeeded();
      await page.getByRole('button', { name: '7페이지 다시 불러오기', exact: true }).waitFor();
      await page.waitForTimeout(250);
      await page.getByRole('button', { name: '7페이지 다시 불러오기', exact: true }).evaluate((button) =>
        button.addEventListener(
          'click',
          () => {
            globalThis.repairCorrupt = true;
          },
          { once: true, capture: true },
        ),
      );
      const corruptRequests = await page.evaluate(
        () => calls.filter(([id, index]) => id === 'fixture-1' && index === 6).length,
      );
      await page.getByRole('button', { name: '7페이지 다시 불러오기', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('article[data-page-index="6"] img')?.naturalWidth > 0);
      assert.equal(
        await page.evaluate(() => calls.filter(([id, index]) => id === 'fixture-1' && index === 6).length),
        corruptRequests + 1,
      );
      await page.evaluate(() => {
        const root = document.querySelector('.fixed-doc-viewport'),
          row = document.querySelector('article[data-page-index="24"]');
        root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top + 120;
      });
      await page.waitForFunction(() => document.querySelector('article[data-page-index="24"] img')?.naturalWidth > 0);
      await page.waitForTimeout(200);
      // Position within the decoded image, after estimated page sizes have settled.
      await page.evaluate(() => {
        const root = document.querySelector('.fixed-doc-viewport');
        const row = document.querySelector('article[data-page-index="24"]');
        root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top + 120;
      });
      await page.waitForTimeout(500);
      assert.equal(
        await page.evaluate(() => JSON.parse(localStorage.getItem('moya.source-stream-positions.v1')).at(-1)[1].page),
        24,
      );
      await page.reload();
      await page.waitForFunction(() => document.querySelector('article[data-page-index="24"] img')?.naturalWidth > 0);
      await page.waitForTimeout(300);
      const offset = await page.evaluate(
        () =>
          document.querySelector('.fixed-doc-viewport').getBoundingClientRect().top -
          document.querySelector('article[data-page-index="24"]').getBoundingClientRect().top,
      );
      assert(Math.abs(offset - 120) < 5, `resumed offset ${offset}`);
      // Existing auto-reading overlay, with no stream-specific toolbar.
      await reveal(page);
      const menu = page.getByRole('button', { name: '문서 메뉴', exact: true });
      if (await menu.isVisible()) await menu.click();
      await page.getByRole('button', { name: '자동 읽기', exact: true }).click();
      await page.getByLabel('항상 오버레이 표시').check();
      await page.getByRole('button', { name: '시작', exact: true }).click();
      await page.getByRole('button', { name: '자동 읽기 일시정지', exact: true }).click();
      await page.getByRole('button', { name: '자동 읽기 재개', exact: true }).waitFor();
    } else {
      await reveal(page);
      await page.getByRole('button', { name: '만화 보기 설정', exact: true }).click();
      assert.equal(await page.getByLabel(/^조판/).inputValue(), view);
      await page.getByLabel(/^읽는 방향/).selectOption('rtl');
      await page.getByRole('button', { name: '만화 보기 설정 닫기', exact: true }).click();
      const box = await page.locator('.fixed-doc-viewport').boundingBox();
      await page.mouse.click(box.x + box.width * 0.14, box.y + box.height * 0.5);
      await page.waitForFunction(
        () => Number(document.querySelector('.fixed-doc-pages article.is-current')?.dataset.pageIndex) > 0,
      );
    }
    if (view === 'spread') assert.equal(await page.locator('.fixed-doc-pages article').count(), 2);
    await reveal(page);
    const before = await page.evaluate(() => calls.filter(([id, index]) => id === 'fixture-2' && index === 0).length);
    await page.locator('.fixed-doc-footer').getByRole('button', { name: '다음 회차', exact: true }).click();
    await page.waitForFunction(
      () =>
        episode === 2 && document.querySelector('.fixed-doc-pages article[data-page-index="0"] img')?.naturalWidth > 0,
    );
    if (prefetch)
      assert.equal(
        await page.evaluate(() => calls.filter(([id, index]) => id === 'fixture-2' && index === 0).length),
        before,
        'Prepared bytes reused by the existing viewer',
      );
    await page.waitForTimeout(400);
    assert.equal(
      await page.evaluate(() => positionWrites.some(([episode, index]) => episode === 2 && index >= 15)),
      false,
      'A next episode starts at its beginning, not its prior history or the previous episode position',
    );
    if (mixed) {
      assert.equal(await page.evaluate(() => remoteOpens.includes('fixture-2')), false);
      assert(await page.evaluate(() => savedReads.includes('fixture-2')));
    }
    if (view === 'vertical') {
      await page.evaluate(() => {
        globalThis.expireNext = true;
      });
      await page.locator('article[data-page-index="29"]').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector('article[data-page-index="29"] img')?.naturalWidth > 0);
    } else {
      await reveal(page);
      const seek = page.getByRole('slider', { name: '만화 페이지 빠르게 이동' });
      await seek.focus();
      await seek.press('End');
      await page.waitForFunction(() => document.querySelector('article[data-page-index="29"] img')?.naturalWidth > 0);
    }
    {
      await reveal(page);
      const menu = page.getByRole('button', { name: '문서 메뉴', exact: true });
      if (await menu.isVisible()) await menu.click();
      await page.getByRole('button', { name: '자동 읽기', exact: true }).click();
      if (view !== 'vertical') await page.getByLabel('자동 읽기 방식', { exact: true }).selectOption('page-turn');
      await page.getByLabel('회차 끝에서 다음 회차로 이동').check();
      await page.getByRole('button', { name: '시작', exact: true }).click();
      await page.waitForFunction(() => episode === 3, undefined, { timeout: 15000 });
      await page.waitForFunction(
        () => document.querySelector('.fixed-doc-pages article[data-page-index="0"] img')?.naturalWidth > 0,
      );
      await page.getByRole('button', { name: '자동 읽기 일시정지', exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mode, width, view, prefetch, mixed, passed: true }));
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
