import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// Real product components + authenticated GraphQL client against a synthetic upstream. Never installs public APKs.
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { build } = require('esbuild') as typeof import('../../apps/server/node_modules/esbuild');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, '.tmp', `suwayomi-extensions-browser-${Date.now()}`);
await mkdir(output, { recursive: true });
await build({
  stdin: {
    contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {InstalledExtensionsPanel} from './src/features/extensions/InstalledExtensionsPanel';
      import {SuwayomiExtensionManager} from './src/external-sources/suwayomi/suwayomi-extension-manager';
      import {SuwayomiGraphqlClient} from './src/external-sources/suwayomi/suwayomi-graphql-client';
      import {validateRepositoryIndex} from './src/extensions/packages/repository-contract';
      import './src/styles/tokens.css'; import './src/styles/base.css';
      import './src/features/reader-settings/reader-settings-panel.css';
      const snapshot={revision:0,available:true,packages:[],sources:[],errors:[]};
      const manager={target:'server',subscribe:()=>()=>{},getSnapshot:()=>snapshot,refresh:async()=>{},
        listRepositories:async()=>[],refreshRepository:async(url)=>validateRepositoryIndex([{pkg:'org.example.manga',apk:'example.apk',sources:[]}],url)};
      const client=new SuwayomiGraphqlClient(location.origin,fetch.bind(window),()=>({mode:'ui_login',accessToken:'fixture-session'}),async()=>{});
      const suwayomi=new SuwayomiExtensionManager(client,()=>true,async()=>{});
      createRoot(document.getElementById('root')).render(<main style={{maxWidth:720,margin:'20px auto',padding:16}}>
        <InstalledExtensionsPanel manager={manager} suwayomi={suwayomi}/></main>);`,
    resolveDir: root,
    loader: 'tsx',
    sourcefile: 'suwayomi-fixture.tsx',
  },
  bundle: true,
  outfile: resolve(output, 'fixture.js'),
  jsx: 'automatic',
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});
let repositories = ['https://existing.example/repo.json'];
const rows = Array.from({ length: 27 }, (_, i) => ({
  pkgName: `org.example.manga${i}`,
  name: `만화 확장 ${String(i).padStart(2, '0')} 긴 이름도 화면 안에 표시`,
  lang: 'ko',
  versionName: '1.4.1',
  isInstalled: false,
  hasUpdate: false,
  isObsolete: false,
  storeIndexUrl: 'https://catalog.example/repo.json',
}));
rows.push({ ...rows[0], pkgName: 'org.example.novel', name: 'Excluded Novel' });
const mutations: string[] = [];
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/api/graphql') {
      assert.equal(request.headers.authorization, 'Bearer fixture-session');
      const buffers: Buffer[] = [];
      for await (const chunk of request) buffers.push(Buffer.from(chunk));
      const { query, variables } = JSON.parse(Buffer.concat(buffers).toString());
      let data: unknown;
      if (query.includes('MoyaExtensionApi')) data = { __type: { name: 'ExtensionStoreType' } };
      else if (query.includes('MoyaExtensionStores'))
        data = {
          extensionStores: {
            nodes: repositories.map((indexUrl) => ({ indexUrl, name: indexUrl })),
            totalCount: repositories.length,
          },
        };
      else if (query.includes('MoyaExtensions('))
        data = { extensions: { nodes: rows.slice(variables.offset, variables.offset + 500), totalCount: rows.length } };
      else if (query.includes('MoyaExtensionState'))
        data = { extension: rows.find((row) => row.pkgName === variables.id) ?? null };
      else if (query.includes('MoyaEditExtensionStore')) {
        const add = query.includes('addExtensionStore');
        if (add) repositories.push(variables.input.indexUrl.replace('/index.min.json', '/repo.json'));
        else repositories = repositories.filter((url) => url !== variables.input.indexUrl);
        data = { [add ? 'addExtensionStore' : 'removeExtensionStore']: { clientMutationId: null } };
      } else if (query.includes('MoyaFetchExtensions')) {
        for (const row of rows) if (row.isInstalled) row.hasUpdate = true;
        data = { fetchExtensions: { clientMutationId: null } };
      } else if (query.includes('MoyaChangeExtension')) {
        const row = rows.find((item) => item.pkgName === variables.input.id)!;
        assert(!row.pkgName.includes('novel'));
        row.isInstalled = !variables.input.patch.uninstall;
        row.hasUpdate = false;
        if (variables.input.patch.update) row.versionName = '1.4.2';
        data = { updateExtension: { extension: row } };
      } else throw new Error(query);
      if (query.startsWith('mutation')) mutations.push(query);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data }));
      return;
    }
    if (request.url === '/fixture.js' || request.url === '/fixture.css') {
      response.setHeader('Content-Type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
      response.end(await readFile(resolve(output, request.url.slice(1))));
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>',
    );
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('listen failed');
const browser = await chromium.launch({
  channel: process.env.READER_UI_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole('button', { name: '저장소', exact: true }).click();
  await page.getByRole('textbox', { name: '저장소 주소', exact: true }).fill('https://catalog.example/index.min.json');
  await page.getByRole('button', { name: '저장소 추가', exact: true }).click();
  await page.getByRole('button', { name: 'APK 저장소 관리 열기' }).click();
  const panel = page.getByRole('region', { name: 'Suwayomi 확장 관리' });
  await panel.getByRole('button', { name: '저장소 추가', exact: true }).click();
  await panel.getByRole('button', { name: '상태 새로고침' }).waitFor();
  await panel.getByLabel('Suwayomi 저장소 주소').fill('https://second.example/index.min.json');
  await panel.getByRole('button', { name: '저장소 추가', exact: true }).click();
  await panel.getByRole('button', { name: '상태 새로고침' }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('input[placeholder="https://example.com/index.min.json"]')?.hasAttribute('disabled'),
  );
  assert.equal(repositories.length, 3);
  assert.equal(await panel.locator('li').count(), 20);
  assert.equal(await panel.getByText('Excluded Novel').count(), 0);
  await panel.getByRole('button', { name: '다음', exact: true }).click();
  assert.equal(await panel.locator('li').count(), 8);
  await panel.getByText('Excluded Novel', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '이전', exact: true }).click();
  await panel.locator('li').first().getByRole('button', { name: '설치', exact: true }).click();
  const review = panel.getByRole('group', { name: 'Suwayomi 확장 작업 확인' });
  for (const width of [390, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: resolve(output, `review-${width}.png`), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow ${width}`);
  }
  await review.getByRole('button', { name: '설치', exact: true }).click();
  await panel.locator('li').first().getByRole('button', { name: '제거', exact: true }).waitFor();
  await panel.getByRole('button', { name: '업데이트 확인', exact: true }).click();
  await panel.locator('li').first().getByRole('button', { name: '업데이트', exact: true }).click();
  await review.getByRole('button', { name: '업데이트', exact: true }).click();
  await panel.locator('li').first().getByText('ko · 1.4.2 · 설치됨').waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Suwayomi 확장', exact: true }).click();
  await panel.locator('li').first().getByText('ko · 1.4.2 · 설치됨').waitFor();
  await panel.getByLabel('Suwayomi 저장소 선택').selectOption('https://second.example/repo.json');
  await panel.getByRole('button', { name: '저장소 제거', exact: true }).click();
  await panel
    .getByRole('group', { name: '저장소 제거 확인' })
    .getByRole('button', { name: '제거', exact: true })
    .click();
  await panel.locator('li').first().getByRole('button', { name: '제거', exact: true }).click();
  await review.getByRole('button', { name: '제거', exact: true }).click();
  await panel.locator('li').first().getByRole('button', { name: '설치', exact: true }).waitFor();
  assert.equal(repositories.length, 2);
  assert(repositories.includes('https://existing.example/repo.json'));
  assert.equal(mutations.filter((query) => query.includes('MoyaChangeExtension')).length, 3);
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, 'result.json'),
    JSON.stringify(
      { status: 'pass', widths: [390, 768, 1024], pageErrors: errors, mutations: mutations.length },
      null,
      2,
    ),
  );
  console.log(`PASS Suwayomi extension UI / ${output}`);
} finally {
  await browser.close();
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
}
