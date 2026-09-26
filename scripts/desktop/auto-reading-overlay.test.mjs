import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

test('mobile auto-reading controls pause/resume without covering the reading viewport', async () => {
  const entry = '/__auto-overlay.tsx';
  const server = await createServer({
    configFile: false,
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'auto-overlay-proof',
        resolveId(id) {
          if (id === entry) return id;
        },
        load(id) {
          if (id !== entry) return;
          return `import React, {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AutoScrollControls} from '/src/features/reader/AutoScrollControls';
import {useAutoScroll} from '/src/features/reader/use-auto-scroll';
import '/src/styles/reader-shell.css';
import '/src/features/fixed-document/fixed-document.css';
function App() {
 const [open,setOpen]=useState(true);
 const viewport=useRef(null);
 const adapter=useRef({flow:'scroll',advanceAutoScroll(pixels){viewport.current.scrollTop+=pixels;return 'moving'}});
 const controller=useAutoScroll(adapter,'book:chapter',true);
 return <main className="reader-screen immersive">
  <div className="reader-viewport-stack"><div ref={viewport} className="reader-scroll reader-viewport-layer is-active">
   {Array.from({length:80},(_,i)=><p key={i}>읽을 본문 {i+1}. 오버레이가 글을 가리지 않습니다.</p>)}
  </div></div>
  <AutoScrollControls controller={controller} open={open} onClose={()=>setOpen(false)} allowed={true}/>
 </main>;
}
createRoot(document.getElementById('root')).render(<App/>);`;
        },
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url !== '/__auto-overlay') return next();
            res.setHeader('Content-Type', 'text/html');
            res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>
          *{box-sizing:border-box}body{margin:0} :root{--reading-margin-y:16px;--reading-margin-x:16px;--reader-canvas:#fff;--surface:#fff;--text:#111;--border:#aaa;--layer-floating:40}
          </style><div id="root"></div><script type="module" src="${entry}"></script>`);
          });
        },
      },
    ],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__auto-overlay`);
    await page.getByRole('checkbox', { name: '항상 오버레이 표시' }).check();
    await page.getByRole('button', { name: '시작', exact: true }).click();
    const pause = page.getByRole('button', { name: '자동 읽기 일시정지' });
    await pause.waitFor();
    assert.equal(await pause.innerText(), '');
    const rect = await pause.boundingBox();
    assert.equal(rect.width, 44);
    assert.equal(rect.height, 44);
    const viewport = page.locator('.reader-scroll');
    await page.waitForFunction(() => document.querySelector('.reader-scroll').scrollTop > 1);
    assert((await viewport.boundingBox()).y + (await viewport.boundingBox()).height <= rect.y);
    await pause.click();
    const resume = page.getByRole('button', { name: '자동 읽기 재개' });
    await resume.waitFor();
    const paused = await viewport.evaluate((e) => e.scrollTop);
    await page.waitForTimeout(150);
    assert.equal(await viewport.evaluate((e) => e.scrollTop), paused);
    await resume.click();
    await page.waitForFunction((p) => document.querySelector('.reader-scroll').scrollTop > p, paused);
    await pause.click();
    if (process.env.MOYA_OVERLAY_SCREENSHOT) await page.screenshot({ path: process.env.MOYA_OVERLAY_SCREENSHOT });
    // The shared controls must also sit outside the comic/document viewport.
    await page.evaluate(() => {
      document.querySelector('main').className = 'fixed-doc-screen is-immersive';
      document.querySelector('.reader-viewport-stack').className = 'fixed-doc-workspace is-sidebar-closed';
      document.querySelector('.reader-scroll').className = 'fixed-doc-viewport';
    });
    const comicViewport = await page.locator('.fixed-doc-viewport').boundingBox();
    const comicButton = await resume.boundingBox();
    assert(comicViewport.y + comicViewport.height <= comicButton.y);
    await page.reload();
    assert.equal(await page.getByRole('checkbox', { name: '항상 오버레이 표시' }).isChecked(), true);
    assert.equal(await page.locator('.reader-auto-scroll-stop').count(), 0);
    await page.getByRole('checkbox', { name: '항상 오버레이 표시' }).uncheck();
    await page.getByRole('button', { name: '시작', exact: true }).click();
    await pause.click();
    assert.equal(await page.locator('.reader-auto-scroll-stop').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
