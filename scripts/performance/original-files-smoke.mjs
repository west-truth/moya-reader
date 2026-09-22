import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {OriginalFilesDialog} from '${root}src/features/library/OriginalFilesDialog.tsx';
import {RemoteBookAssetRepository} from '${root}src/repositories/remote-book-asset-repository.ts';
import {RemoteApiClient} from '${root}src/services/remote/remote-api-client.ts';
${[...readFileSync(root + 'src/main.tsx', 'utf8').matchAll(/import '\.\/styles\/([^']+)';/g)].map((m) => `import '${root}src/styles/${m[1]}';`).join('\n')}
const repository=new RemoteBookAssetRepository(new RemoteApiClient('/api',{getAuthToken:()=> 'fixture'}));
function Fixture(){const [open,setOpen]=useState(true);return React.createElement(React.Fragment,null,
React.createElement('button',{onClick:()=>setOpen(true)},'원본 다운로드'),
open&&React.createElement(OriginalFilesDialog,{book:{id:'book',title:'긴 제목의 EPUB 합본'},repository,onClose:()=>setOpen(false),onLegacyExport:()=>{throw Error('unexpected legacy export')}}));}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));`;
const { output } = await build({
  root,
  configFile: false,
  logLevel: 'error',
  plugins: [
    {
      name: 'original-files-fixture',
      resolveId: (id) => (id === 'fixture' ? '\0fixture.tsx' : undefined),
      load: (id) => (id === '\0fixture.tsx' ? source : undefined),
    },
  ],
  build: { write: false, rollupOptions: { input: 'fixture' } },
});
const entry = output.find((asset) => asset.isEntry);
const payload = Buffer.from('original file contents\n'.repeat(1000));
const ticket = 't'.repeat(43);
let requestedFile;
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path.startsWith('/api/books/')) {
    if (request.headers.authorization !== 'Bearer fixture') {
      response.writeHead(401).end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST') {
      requestedFile = path;
      response.end(JSON.stringify({ ticket }));
      return;
    }
    response.end(
      JSON.stringify({
        files: Array.from({ length: 35 }, (_, i) => ({
          id: `part-${i}`,
          fileName: i === 0 ? '2권.epub' : '아주_긴_한글_원본_파일_이름_'.repeat(5) + `${i + 2}권.cbz`,
          byteLength: 2 * 1024 ** 3,
          contentType: 'application/epub+zip',
          contentHash: 'fixture',
        })),
      }),
    );
    return;
  }
  if (path === `/api/original-downloads/${ticket}`) {
    response.setHeader('Content-Disposition', "attachment; filename=original.epub; filename*=UTF-8''2%EA%B6%8C.epub");
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', String(payload.length));
    response.end(payload);
    return;
  }
  const asset = output.find((item) => '/' + item.fileName === path);
  response.setHeader(
    'Content-Type',
    asset ? (asset.type === 'chunk' ? 'application/javascript' : 'text/css') : 'text/html',
  );
  response.end(
    asset
      ? (asset.code ?? asset.source)
      : `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${output
          .filter((item) => item.fileName.endsWith('.css'))
          .map((item) => `<link rel="stylesheet" href="/${item.fileName}">`)
          .join('')}<div id="root"></div><script type="module" src="/${entry.fileName}"></script>`,
  );
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.READER_UI_BROWSER_EXECUTABLE });
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const width of [320, 390, 1366]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const button = page.getByRole('button', { name: '2권.epub 다운로드', exact: true });
    await button.waitFor();
    assert.equal(await page.locator('.original-files-list li').count(), 30);
    const bounds = await page.locator('.original-files-dialog').evaluate((node) => {
      const b = node.getBoundingClientRect();
      return {
        left: b.left,
        right: b.right,
        top: b.top,
        bottom: b.bottom,
        overflow: node.scrollWidth - node.clientWidth,
      };
    });
    assert(
      bounds.left >= 0 && bounds.right <= width && bounds.top >= 0 && bounds.bottom <= 845 && bounds.overflow <= 1,
    );
    const downloaded = page.waitForEvent('download');
    await button.click();
    const download = await downloaded;
    assert.equal(await download.failure(), null);
    assert.equal(download.suggestedFilename(), '2권.epub');
    assert.deepEqual(readFileSync(await download.path()), payload);
    assert.equal(requestedFile, '/api/books/book/original-files/part-0/download');
    await page.getByRole('button', { name: '더 보기', exact: true }).click();
    assert.equal(await page.locator('.original-files-list li').count(), 35);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(`original files: ${width}px layout, native download, pagination and close passed`);
  }
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
