import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { build, transformWithEsbuild } from 'vite';
import { chromium } from 'playwright-core';
const root = process.cwd();
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SourceReleaseMenu} from '${root}/src/features/external-sources/SourceReleaseMenu.tsx';
import {Dialog} from '${root}/src/shared/ui/Dialog.tsx';
import {ModalDrawer} from '${root}/src/shared/ui/ModalDrawer.tsx';
import {LayerPresence} from '${root}/src/shared/ui/LayerPresence.tsx';
${[...readFileSync(root + '/src/main.tsx', 'utf8').matchAll(/import '\.\/styles\/([^']+)';/g)].map((match) => `import '${root}/src/styles/${match[1]}';`).join('\n')}
globalThis.calls=[];
const Overlay=new URLSearchParams(location.search).has('drawer') ? ModalDrawer : Dialog;
function Fixture(){
 const [titles,setTitles]=React.useState({});
 const [dialog,setDialog]=React.useState(false);
 const controller={busy:false,setReleasesRead:async(items,read)=>calls.push(['read',items[0].key.remoteId,read]),markPreviousReleasesRead:async item=>calls.push(['previous',item.key.remoteId]),deleteDownloads:async items=>calls.push(['delete',items[0].key.remoteId]),renameRelease:async(item,title)=>{calls.push(['rename',item.key.remoteId,title]);setTitles(values=>({...values,[item.key.remoteId]:title}));}};
 return <><button id="outside" onClick={()=>setDialog(true)}>설정 열기</button><div data-screen-motion="forward"><div className="library-workspace" style={{display:'block'}}><div className="source-hub-scroll is-work-detail" style={{height:'calc(100dvh - 50px)',overflow:'auto'}}><div style={{height:280}}>작품 정보</div>{Array.from({length:20},(_,i)=>{const id=String(i+1),item={key:{connectorId:'fixture',remoteId:id},title:titles[id]??id+'화',originalTitle:id+'화',localBookId:'book',importState:'imported',readingState:'unread'};return <div key={id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:12,height:64}}><button onClick={()=>calls.push(['open',id])}>{item.title} 읽기</button><SourceReleaseMenu item={item} controller={controller}/></div>;})}</div></div></div><LayerPresence open={dialog}><Overlay closeLabel="대화상자 닫기" open={dialog} title="검증 설정" onClose={()=>setDialog(false)}><button onClick={()=>calls.push(['setting'])}>옵션 변경</button></Overlay></LayerPresence></>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
const result = await build({
  root,
  configFile: false,
  logLevel: 'error',
  plugins: [
    {
      name: 'fixture',
      resolveId: (id) => (id === 'fixture' ? '\0fixture.tsx' : undefined),
      load: async (id) =>
        id === '\0fixture.tsx'
          ? (await transformWithEsbuild(source, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })).code
          : undefined,
    },
  ],
  esbuild: { jsx: 'automatic' },
  build: { write: false, rollupOptions: { input: 'fixture' } },
});
const output = result.output;
const entry = output.find((asset) => asset.isEntry);
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://fixture').pathname;
  const asset = output.find((asset) => '/' + asset.fileName === path);
  if (asset) {
    res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.end(asset.code ?? asset.source);
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      output
        .filter((asset) => asset.fileName.endsWith('.css'))
        .map((asset) => '<link rel="stylesheet" href="/' + asset.fileName + '">')
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
mkdirSync(root + '/.tmp/source-detail-review', { recursive: true });
try {
  for (const width of [390, 1280])
    for (const reducedMotion of ['no-preference', 'reduce'])
      for (const layer of ['dialog', 'drawer']) {
        const page = await browser.newPage({
          viewport: { width, height: 844 },
          reducedMotion,
          hasTouch: width === 390,
        });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.setDefaultTimeout(5000);
        await page.goto(`http://127.0.0.1:${server.address().port}/?${layer}`);
        const trigger = page.getByRole('button', { name: '10화 더보기', exact: true });
        await trigger.scrollIntoViewIfNeeded();
        await trigger.click();
        const menu = page.getByRole('menu');
        await menu.waitFor();
        const box = await menu.boundingBox();
        assert(
          box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 844,
          `menu outside viewport: ${JSON.stringify(box)}`,
        );
        await page.getByRole('menuitem', { name: '읽음으로 변경', exact: true }).click();
        assert.deepEqual(await page.evaluate(() => calls), [['read', '10', true]]);
        await trigger.click();
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'hidden' });
        assert(await trigger.evaluate((node) => node === document.activeElement));
        await trigger.click();
        await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await trigger.click();
        await page.getByRole('menuitem', { name: '제목 수정' }).click();
        await page.getByRole('textbox', { name: '회차 제목', exact: true }).fill('수정한 제목');
        await page.getByRole('button', { name: '저장', exact: true }).click();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        const renamed = page.getByRole('button', { name: '수정한 제목 더보기', exact: true });
        await renamed.click();
        await page.getByRole('menuitem', { name: '수정한 제목 다운로드 삭제' }).click();
        assert.deepEqual(await page.evaluate(() => calls), [
          ['read', '10', true],
          ['previous', '10'],
          ['rename', '10', '수정한 제목'],
          ['delete', '10'],
        ]);
        await renamed.click();
        await page.locator('#outside').click();
        await menu.waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: '옵션 변경' }).click();
        const closedLayerAcceptsFocus = await page.evaluate(async () => {
          document.querySelector('[aria-label="대화상자 닫기"]').click();
          await new Promise(requestAnimationFrame);
          const closing = document.querySelector('[data-state="closed"]');
          closing?.querySelector('button')?.focus();
          return Boolean(closing?.contains(document.activeElement));
        });
        assert.equal(closedLayerAcceptsFocus, false, 'closed dialog still accepts keyboard focus');
        await page.locator('#outside').click();
        await page.waitForTimeout(500);
        await page.getByRole('button', { name: '옵션 변경' }).click();
        await page.getByRole('button', { name: '대화상자 닫기' }).click();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: '수정한 제목 읽기' }).click();
        assert.deepEqual((await page.evaluate(() => calls)).slice(-2), [['setting'], ['open', '10']]);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ width, reducedMotion, layer, passed: true }));
        await page.close();
      }
} catch (error) {
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      console.log(
        await page.evaluate(() => ({
          calls,
          active: document.activeElement?.outerHTML,
          menus: document.querySelectorAll('[role=menu]').length,
        })),
      );
      await page.screenshot({ path: root + '/.tmp/source-detail-review/failure.png' });
    }
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
