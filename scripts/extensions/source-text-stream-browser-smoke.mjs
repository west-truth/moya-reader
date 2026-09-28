import { build, transformWithEsbuild } from 'vite';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const root = process.cwd();
const code = `import React from 'react';import{createRoot}from'react-dom/client';
import{RuntimeProvider}from'${root}/src/app/runtime/RuntimeProvider.tsx';
import{SourceStreamReader}from'${root}/src/features/external-sources/SourceStreamReader.tsx';
import{useSourceStreamNavigation}from'${root}/src/features/external-sources/use-source-stream-navigation.ts';
import{defaultSettings}from'${root}/src/repositories/reader-defaults.ts';
import{useSourceStreamProgress}from'${root}/src/features/external-sources/use-source-stream-progress.ts';
import{recoverSourceStreamVisits}from'${root}/src/external-sources/source-stream-visit-journal.ts';
import{latestSourceVisits}from'${root}/src/features/external-sources/source-release-reading.ts';
import ReaderScreen from '${root}/src/features/reader/ReaderScreen.tsx';
import{sourceTextDocument}from'${root}/src/features/external-sources/source-text-document.ts';
import{ReaderScreenHandle}from'${root}/src/features/reader/reader-screen-contract.ts';
${['tokens', 'base', 'shell', 'reader-shell', 'reader-content', 'reader-addons', 'reader-tools', 'dialogs-import', 'responsive'].map((s) => `import '${root}/src/styles/${s}.css';`).join('\n')}
const params=new URLSearchParams(location.search);
localStorage.setItem('moya.source-reading.v1',JSON.stringify({mode:params.get('mode')||'stream-save',prefetch:Number(params.get('prefetch')??8)}));
globalThis.opens=[];globalThis.saves=[];globalThis.targets=[];globalThis.positions=[];
const state={listLinks:async()=>[],listReleasePreferences:async()=>JSON.parse(localStorage.getItem('fixture.preferences')||'[]'),saveReleasePreferences:async records=>{if(globalThis.blockWrites)await new Promise(()=>{});localStorage.setItem('fixture.preferences',JSON.stringify(records));}};
const progressOptions={settingsScope:'fixture',state,getNovel:async()=>undefined,notify:()=>{}};
const port={kind:'text',open:async(id,signal)=>{opens.push(id);if(id==='2')await new Promise((resolve,reject)=>{globalThis.releaseOpen=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true})});if(id==='3'&&!globalThis.repaired)throw Error('본문 연결 재시도');return{text:(params.has('reload')&&!sessionStorage.getItem('downloaded-copy')?'\\n\\n':'')+Array.from({length:180},(_,i)=>id+'화 문단 '+i+' 스트리밍 소설의 본문을 기존 리더로 읽습니다. '.repeat(12)).join('\\n\\n')};}};
const runtime={readerRuntime:{readerRepository:{},bookAssetRepository:{}}};
function Fixture(){const[episode,setEpisode]=React.useState(globalThis.bootEpisode||1);globalThis.jumpEpisode=setEpisode;const[settings,setSettings]=React.useState({...defaultSettings,readingProfile:{...defaultSettings.readingProfile,modeLock:'auto'}});globalThis.episode=episode;
const items=Array.from({length:4},(_,i)=>({key:{connectorId:'fixture',remoteId:String(i+1)},title:(i+1)+'화',collection:{remoteId:'work'},release:{title:(i+1)+'화',sourceOrder:i+1},importState:i===3?'imported':'available'}));
const progress=useSourceStreamProgress({current:()=>progressOptions,onRead:()=>{},onSaved:()=>{}});
const[catalogReady,setCatalogReady]=React.useState(!params.has('catalog'));
const nav=useSourceStreamNavigation({streaming:{item:items[episode-1]},items:catalogReady?items:items.slice(0,1),nextCursor:catalogReady?undefined:'next',loadMore:async()=>{await new Promise(resolve=>globalThis.releaseCatalog=resolve);setCatalogReady(true)},openStreamItem:async item=>{targets.push(item.key.remoteId);setEpisode(Number(item.key.remoteId))}});
const actions={...new ReaderScreenHandle().getActions(),notify:message=>console.log(message),updateReadingProfile:patch=>setSettings(s=>({...s,readingProfile:{...s.readingProfile,...patch}}))};
return <RuntimeProvider runtime={runtime}><SourceStreamReader title={episode+'화'} port={port} remoteId={String(episode)} historyKey={String(episode)} profileKey="work" fromStart={!params.has('reload')&&episode>1} textReader={{settings,settingsOpen:false,actions}} onClose={()=>{globalThis.closed=true}} onSave={()=>{saves.push(episode);return new Promise(resolve=>{(globalThis.releaseSaves??=[]).push(resolve)})}} onTextPosition={async p=>{positions.push([episode,p]);if(params.has('reload'))await progress.record(items[episode-1],{kind:'text',...p});}} previous={nav.previous} next={nav.next} navigationBusy={nav.busy} nextEpisode={nav.nextItem?{remoteId:nav.nextItem.key.remoteId,title:nav.nextItem.title}:undefined}/></RuntimeProvider>;
}
function LocalFixture(){const[handle]=React.useState(()=>new ReaderScreenHandle());const[entry,setEntry]=React.useState();const[number,setNumber]=React.useState(1);
React.useEffect(()=>{void sourceTextDocument({text:Array.from({length:60},(_,i)=>'문단 '+i+' 페이지 모드 유지 검사입니다.'.repeat(20)).join('\\n\\n'),title:number+'화',workId:'local-book',episodeId:String(number),historyKey:String(number),settings:defaultSettings}).then(value=>{handle.prepareOpen(value.chapter.id);setEntry(value);});},[number]);
handle.setActions({...handle.getActions(),openChapter:async()=>{setEntry(undefined);setNumber(n=>n+1)}});
if(!entry)return null;const chapter={...entry.chapter,index:1};return <RuntimeProvider runtime={runtime}><ReaderScreen screenHandle={handle} repository={entry.repository} model={{novel:entry.novel,chapter,chapters:[chapter,{...chapter,id:'next',index:2}],settings:defaultSettings,bookmarks:[],highlights:[],addonOpen:false,addonTab:'outline',overlays:{settingsOpen:false,syncPanelOpen:false,importOpen:false},canRestoreSavedPosition:false,statsVisible:false,openRequestVersion:number}}/></RuntimeProvider>;
}
void (async()=>{if(params.has('reload')){const records=await recoverSourceStreamVisits('fixture',state);const visit=[...latestSourceVisits(records).values()].sort((a,b)=>b.lastReadAt.localeCompare(a.lastReadAt))[0];globalThis.bootEpisode=Number(visit?.source.remoteId||1);}createRoot(document.getElementById('root')).render(params.has('local')?<LocalFixture/>:<Fixture/>);})();`;
const result = await build({
  root,
  configFile: false,
  logLevel: 'error',
  plugins: [
    {
      name: 'fixture',
      resolveId: (id) => (id === 'fixture' ? '\0fixture.tsx' : undefined),
      load: async (id) => {
        if (process.env.SOURCE_TEXT_BASELINE_FLOW && id.endsWith('/src/features/reader/ReaderScreen.tsx'))
          return execFileSync('git', ['show', '325c655:src/features/reader/ReaderScreen.tsx'], {
            encoding: 'utf8',
          }).replace(
            'const repository = readerRuntime.readerRepository;',
            'const repository = arguments[0].repository ?? readerRuntime.readerRepository;',
          );
        return id === '\0fixture.tsx'
          ? (await transformWithEsbuild(code, 'fixture.tsx', { jsx: 'automatic' })).code
          : undefined;
      },
    },
  ],
  esbuild: { jsx: 'automatic' },
  build: { write: false, rollupOptions: { input: 'fixture' } },
});
const output = result.output,
  entry = output.find((x) => x.isEntry);
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://local').pathname;
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
  headless: true,
  args: ['--no-sandbox'],
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
});
async function checkReload() {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port + '/?reload=1&prefetch=0&mode=stream');
    await page.waitForFunction(() =>
      document.querySelector('.reader-scroll.is-active:not(.is-opening) [data-paragraph-id]'),
    );
    await page.evaluate(() => {
      globalThis.blockWrites = true;
      globalThis.jumpEpisode(4);
    });
    await page.waitForFunction(
      () =>
        document.querySelector('.reader-title strong')?.textContent === '4화' &&
        document.querySelector('.reader-scroll.is-active:not(.is-opening) [data-paragraph-id]'),
    );
    for (const top of [2500, 6000]) {
      await page.locator('.reader-scroll.is-active').evaluate((node, y) => {
        node.scrollTop = y;
      }, top);
      await page.waitForTimeout(500);
    }
    const before = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('moya.source-stream-positions.v1')).find(([key]) =>
          key.startsWith('4:text:'),
        )[1],
    );
    const visibleParagraph = await page.evaluate(() => {
      const root = document.querySelector('.reader-scroll.is-active');
      const top = root.getBoundingClientRect().top + (parseFloat(getComputedStyle(root).paddingTop) || 0);
      const row = [...root.querySelectorAll('[data-index]')].find((node) => node.getBoundingClientRect().bottom > top);
      return Number(row.dataset.index) + 1;
    });
    assert(before.page > 0);
    assert.equal(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('moya.source-stream-pending-visits.v1')).at(-1).preference.source.remoteId,
      ),
      '4',
    );
    await page.evaluate(() => sessionStorage.setItem('downloaded-copy', '1'));
    await page.reload();
    await page.waitForFunction(
      () => episode === 4 && document.querySelector('.reader-scroll.is-active:not(.is-opening) [data-paragraph-id]'),
    );
    await page.waitForTimeout(650);
    const restored = await page.evaluate(() => positions.at(-1)?.[1]?.paragraphIndex);

    assert(Math.abs(restored - visibleParagraph) <= 1, `restored paragraph ${restored}, expected ${visibleParagraph}`);
    assert.equal(await page.evaluate(() => saves.length), 0);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: blocked background save, reload restores episode 4 and paragraph ${restored}`);
    await page.close();
  }
}

async function checkNavigation() {
  if (!process.env.SOURCE_TEXT_SCROLL_ONLY) {
    const local = await browser.newPage({ viewport: { width: 390, height: 844 } });
    local.setDefaultTimeout(10000);
    await local.goto('http://127.0.0.1:' + server.address().port + '/?local');
    await local.waitForFunction(() =>
      document.querySelector('.reader-scroll.is-active:not(.is-opening) [data-paragraph-id]'),
    );
    await local.keyboard.press('ArrowRight');
    await local.waitForFunction(() => document.querySelector('.reader-paginated-root.is-active [data-paragraph-id]'));
    await local.keyboard.press(']');
    await local.waitForFunction(() => document.querySelector('.reader-title strong')?.textContent === '2화');
    assert.equal(
      await local.locator('.reader-screen').getAttribute('data-reading-flow'),
      'paginated',
      'auto layout must survive the loading/remount between local chapters',
    );
    console.log('PASS local reader flow across remount');
    await local.close();
    for (const [width, prefetch, mode] of [
      [390, 0, 'stream-save'],
      [1280, 8, 'stream'],
      [390, 8, 'stream-save'],
    ]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.setDefaultTimeout(15000);
      await page.goto('http://127.0.0.1:' + server.address().port + '/?prefetch=' + prefetch + '&mode=' + mode);
      await page.waitForFunction(() =>
        document.querySelector('.reader-scroll.is-active:not(.is-opening) [data-paragraph-id]'),
      );
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(
        () =>
          document.querySelector('.reader-screen')?.dataset.readingFlow === 'paginated' &&
          document.querySelector('.reader-paginated-root.is-active [data-paragraph-id]'),
      );
      await page.keyboard.press(']');
      await page.waitForFunction(() => episode === 2 && typeof releaseOpen === 'function');
      for (let i = 0; i < 8; i++) await page.keyboard.press(']');
      assert.deepEqual(
        await page.evaluate(() => targets),
        ['2'],
        'repeated navigation while text is loading must not skip chapters',
      );
      await page.evaluate(() => releaseOpen());
      await page.waitForFunction(
        () =>
          document.querySelector('.reader-title strong')?.textContent === '2화' &&
          document.querySelector('.reader-paginated-root.is-active [data-paragraph-id]'),
      );
      assert.equal(
        await page.locator('.reader-screen').getAttribute('data-reading-flow'),
        'paginated',
        'auto flow must survive next chapter',
      );
      await page.keyboard.press(']');
      await page.getByRole('alert').filter({ hasText: '본문 연결 재시도' }).waitFor();
      assert.equal(
        await page.locator('.reader-title strong').textContent(),
        '2화',
        'failure must keep current text readable',
      );
      await page.evaluate(() => {
        globalThis.repaired = true;
      });
      await page.getByRole('button', { name: '다시 시도', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.reader-title strong')?.textContent === '3화');
      assert.equal(await page.locator('.reader-screen').getAttribute('data-reading-flow'), 'paginated');
      await page.keyboard.press(']');
      await page.waitForFunction(() => document.querySelector('.reader-title strong')?.textContent === '4화');
      assert.deepEqual(await page.evaluate(() => targets), ['2', '3', '4']);
      assert.equal(
        await page.evaluate(() => opens.filter((id) => id === '2').length),
        1,
        'prefetched text must be reused',
      );
      if (mode === 'stream') assert.deepEqual(await page.evaluate(() => saves), []);
      else
        assert.ok(
          (await page.evaluate(() => saves)).includes(3),
          'current chapter queues independently of earlier save',
        );
      assert.deepEqual(errors, []);
      console.log('PASS text stream', width, prefetch, mode);
      await page.close();
    }
  }
  const scroll = await browser.newPage({ viewport: { width: 390, height: 844 } });
  scroll.setDefaultTimeout(15000);
  await scroll.goto('http://127.0.0.1:' + server.address().port + '/?prefetch=0&mode=stream&catalog=1');
  await scroll.waitForFunction(() =>
    document.querySelector('.reader-scroll.is-active:not(.is-opening) [data-paragraph-id]'),
  );
  await scroll.keyboard.press('End');
  await scroll.waitForFunction(() => {
    const e = document.querySelector('.reader-scroll.is-active');
    return e && e.scrollTop > 1000;
  });
  const viewport = scroll.locator('.reader-scroll.is-active');
  const box = await viewport.boundingBox();
  await viewport.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await scroll.getByRole('button', { name: '자동 스크롤 설정' }).click();
  await scroll.getByLabel('회차 끝에서 다음 회차로 이동').check();
  await scroll.getByRole('button', { name: '시작', exact: true }).click();
  await scroll.waitForFunction(() => typeof releaseCatalog === 'function');
  await scroll.evaluate(() => releaseCatalog());
  await scroll.waitForFunction(() => episode === 2 && typeof releaseOpen === 'function');
  await scroll.waitForTimeout(500);
  assert.deepEqual(await scroll.evaluate(() => targets), ['2']);
  await scroll.evaluate(() => releaseOpen());
  await scroll.waitForFunction(() => document.querySelector('.reader-title strong')?.textContent === '2화');
  await scroll.getByRole('button', { name: '자동 읽기 일시정지' }).waitFor();
  assert.equal(await scroll.locator('.reader-screen').getAttribute('data-reading-flow'), 'scroll');
  await scroll.getByRole('button', { name: '자동 읽기 일시정지' }).click();
  await scroll.keyboard.press('End');
  await scroll.waitForFunction(() => {
    const e = document.querySelector('.reader-scroll.is-active');
    return e && e.scrollTop > 1000;
  });
  await viewport.hover();
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await scroll.waitForFunction(
    () =>
      document.querySelector('[data-scroll-chapter-boundary]')?.getAttribute('data-scroll-chapter-boundary-armed') ===
      'true',
  );
  for (let i = 0; i < 5; i++) await scroll.mouse.wheel(0, 800);
  await scroll.getByRole('alert').filter({ hasText: '본문 연결 재시도' }).waitFor();
  assert.deepEqual(
    await scroll.evaluate(() => targets),
    ['2', '3'],
    'scroll boundary must only move to the immediate neighbor once',
  );
  console.log('PASS scroll boundary and auto-reading across catalog pages');
  await scroll.close();
  const cancel = await browser.newPage({ viewport: { width: 390, height: 844 } });
  cancel.setDefaultTimeout(15000);
  await cancel.goto('http://127.0.0.1:' + server.address().port + '/?prefetch=0&mode=stream&catalog=1');
  await cancel.waitForFunction(() =>
    document.querySelector('.reader-scroll.is-active:not(.is-opening) [data-paragraph-id]'),
  );
  await cancel.keyboard.press('End');
  await cancel.waitForFunction(() => document.querySelector('.reader-scroll.is-active')?.scrollTop > 1000);
  const cancelViewport = cancel.locator('.reader-scroll.is-active');
  const cancelBox = await cancelViewport.boundingBox();
  await cancelViewport.click({ position: { x: cancelBox.width / 2, y: cancelBox.height / 2 } });
  await cancel.getByRole('button', { name: '자동 스크롤 설정' }).click();
  await cancel.getByLabel('회차 끝에서 다음 회차로 이동').check();
  await cancel.getByRole('button', { name: '시작', exact: true }).click();
  await cancel.waitForFunction(() => typeof releaseCatalog === 'function');
  await cancel.getByRole('button', { name: '자동 읽기 일시정지' }).click();
  await cancel.evaluate(() => releaseCatalog());
  await cancel.waitForTimeout(500);
  assert.deepEqual(
    await cancel.evaluate(() => targets),
    [],
    'pausing during catalog lookup must cancel automatic navigation',
  );
  assert.equal(await cancel.locator('[role="alert"]').count(), 0, 'a user pause is not a loading error');
  // The cancellation must also release navigation ownership for a later manual move.
  await cancel.keyboard.press(']');
  await cancel.waitForFunction(() => episode === 2 && typeof releaseOpen === 'function');
  await cancel.evaluate(() => releaseOpen());
  await cancel.waitForFunction(() => document.querySelector('.reader-title strong')?.textContent === '2화');
  console.log('PASS automatic navigation cancellation and manual retry');
  await cancel.close();
}

try {
  if (process.env.SOURCE_TEXT_RELOAD_ONLY) await checkReload();
  else await checkNavigation();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
