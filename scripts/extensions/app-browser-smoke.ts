import { createRequire } from 'node:module';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright-core';
import { registerAuthHook } from '../../apps/server/src/auth';
import type { ServerConfig } from '../../apps/server/src/config';
import { registerExtensionPackageRoutes } from '../../apps/server/src/routes/extension-packages';
import { PostgresPackageInstallStore } from '../../apps/server/src/extensions/postgres-package-store';
import { createNodePackageExecution } from '../../apps/server/src/extensions/node-package-execution';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../../apps/server/src/services/id-v2-migration/postgres-integration-harness';
import { buildMoyaExtension } from '../../src/extensions/packages/package-builder';
import { examplePackageManifest } from '../../src/test/extension-package-fixture';
import type { ExtensionAppFixture } from './app-fixture';

const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const Fastify = require('fastify') as typeof import('../../apps/server/node_modules/fastify').default;
const root = fileURLToPath(new URL('../../', import.meta.url));
const nativeFixture = process.argv.includes('--native');
const contentServiceFixture = process.argv.includes('--content-service');
if (nativeFixture && contentServiceFixture) throw new Error('Use Hosted for the configured service App gate');
process.chdir(root);
const output = resolve(root, '.tmp', `extension-app-browser-${Date.now()}`);
await mkdir(output, { recursive: true });
const bundle = await build({
  root,
  logLevel: 'error',
  build: { write: false, rollupOptions: { input: resolve(root, 'scripts/extensions/app-fixture.tsx') } },
});
if (Array.isArray(bundle) || !('output' in bundle)) throw new Error('unexpected build output');
const bundledAssets = bundle.output;
const entry = bundledAssets.find((asset) => asset.type === 'chunk' && asset.isEntry)!;
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${bundledAssets
  .filter((a) => a.fileName.endsWith('.css'))
  .map((a) => `<link rel="stylesheet" href="/${a.fileName}">`)
  .join('')}<div id="root"></div><script type="module" src="/${entry.fileName}"></script>`;
const manifest = {
  ...examplePackageManifest(),
  requestedAccess: {
    ...examplePackageManifest().requestedAccess,
    ...(contentServiceFixture
      ? {
          contentServices: [
            { sourceId: 'org.example.catalog.source', version: 1, origins: ['https://catalog.example'] },
          ],
        }
      : {}),
  },
};
manifest.requestedAccess.storageKiB = 4;
manifest.extension.name = '앱 검증용 소스';
manifest.extension.contributes.externalSources[0].title = '앱 검증용 소스';
manifest.extension.contributes.externalSources[0].capabilities.push('search', 'subscriptions');
const source = `globalThis.moyaExtension=async(method,input,host)=>{
 if(method==='describe')return{apiVersion:1,sources:[{id:'org.example.catalog.source',cover:false}]};
 if(method==='source.listWorks')return{items:!input.query||'Synthetic installed novel'.includes(input.query)?[{id:'work',title:'Synthetic installed novel'}]:[]};
 if(method==='source.getWork')return{id:'work',title:'Synthetic installed novel'};
 if(method==='source.listReleases')return{items:[{id:'two',title:'Second chapter',order:2},{id:'one',title:'First chapter',order:1}]};
 if(method==='source.getContent'){
  await host.request('storage.set',{key:input.releaseId,value:'downloaded'});
  if(${contentServiceFixture})return{kind:'service',service:'text-content',version:1,url:'https://catalog.example/work/'+input.releaseId};
  return{kind:'text',asset:await host.request('asset.fromText',{text:'Original '+input.releaseId+' chapter.\\r\\n\\r\\n  Preserved indentation.\\n'})};
 }
};`;
const archive = await buildMoyaExtension({ manifest, source, license: 'Synthetic fixture license' });
const archivePath = resolve(output, 'source.moyaext');
await writeFile(archivePath, new Uint8Array(await archive.arrayBuffer()));
manifest.extension.version = '1.0.1';
const updated = await buildMoyaExtension({
  manifest,
  source: source.replace("items:[{id:'two'", "items:[{id:'three',title:'Third chapter',order:3},{id:'two'"),
  license: 'Synthetic fixture license',
});
const updatePath = resolve(output, 'update.moyaext');
await writeFile(updatePath, new Uint8Array(await updated.arrayBuffer()));
async function runAppGate(pool?: Parameters<Parameters<typeof withPostgresSchema>[2]>[0]) {
  if (pool) {
    await pool.query('create table users(id text primary key)');
    await pool.query("insert into users(id) values ('fixture-owner')");
    await pool.query(
      await readFile(resolve(root, 'apps/server/src/db/migrations/0046_extension_packages.sql'), 'utf8'),
    );
    await pool.query(
      await readFile(resolve(root, 'apps/server/src/db/migrations/0047_extension_source_state.sql'), 'utf8'),
    );
  }
  const app = Fastify();
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, bytes, done) =>
    done(null, bytes),
  );
  if (pool)
    await app.register(async (secured) => {
      await registerAuthHook(secured, { host: '127.0.0.1', authToken: 'fixture-token' } as ServerConfig);
      await registerExtensionPackageRoutes(
        secured,
        new PostgresPackageInstallStore(pool, 'fixture-owner'),
        createNodePackageExecution('self-host-gateway', {
          contentResolver: contentServiceFixture
            ? async ({ url, signal }) => {
                signal.throwIfAborted();
                const id = new URL(url).pathname.split('/').at(-1);
                if (!['one', 'two', 'three'].includes(id!)) throw new Error('invalid_fixture_release');
                return Buffer.from(`Original ${id} chapter.\r\n\r\n  Preserved indentation.\n`);
              }
            : undefined,
        }),
      );
    });
  app.get('/', (_request, reply) => reply.type('text/html').send(html));
  app.get('/branding/moya-wordmark.png', async (_request, reply) =>
    reply.type('image/png').send(await readFile(resolve(root, 'public/branding/moya-wordmark.png'))),
  );
  for (const asset of bundledAssets) {
    app.get(`/${asset.fileName}`, (_request, reply) =>
      reply
        .type(
          asset.fileName.endsWith('.css')
            ? 'text/css'
            : asset.fileName.endsWith('.js')
              ? 'application/javascript'
              : 'application/octet-stream',
        )
        .send(asset.type === 'chunk' ? asset.code : Buffer.from(asset.source)),
    );
  }
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('listen failed');
  console.log('extension app gate: production bundle and isolated API ready');
  const browser = await chromium.launch({
    channel: process.env.READER_UI_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let helper: ChildProcessWithoutNullStreams | undefined;
  let helperToken: string | undefined;
  let helperReady: Promise<{ endpoint: string }> | undefined;
  const stopHelper = async () => {
    if (!helper || helper.exitCode !== null) return;
    const stopped = once(helper, 'exit');
    helper.stdin.end();
    const timer = setTimeout(() => helper?.kill(), 3000);
    try {
      await stopped;
    } finally {
      clearTimeout(timer);
    }
  };
  if (nativeFixture) {
    // Only Tauri process startup is substituted. Fetch/CORS, bundled Node/QuickJS and IndexedDB are real.
    await page.exposeBinding(
      'nativeFixtureInvoke',
      async (_source, command: string, args: { sessionToken: string }) => {
        if (command !== 'desktop_extension_runtime_start') throw new Error(`Unexpected native command: ${command}`);
        if (helperToken !== args.sessionToken) {
          await stopHelper();
          helperToken = args.sessionToken;
          const directory = resolve(root, 'src-tauri/extension-sidecar');
          helper = spawn(resolve(directory, 'node.exe'), [resolve(directory, 'native-entry.mjs')], {
            cwd: directory,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: Object.fromEntries(
              ['SystemRoot', 'WINDIR', 'TMP', 'TEMP'].flatMap((key) =>
                process.env[key] ? [[key, process.env[key]!]] : [],
              ),
            ),
          });
          const lines = createInterface({ input: helper.stdout });
          helperReady = once(lines, 'line').then(([line]) => {
            lines.close();
            return JSON.parse(line);
          });
          helper.stdin.write(JSON.stringify({ token: helperToken, origin: `http://127.0.0.1:${address.port}` }) + '\n');
        }
        return await helperReady;
      },
    );
    await page.addInitScript(
      'globalThis.__TAURI_INTERNALS__ = { invoke: (...args) => globalThis.nativeFixtureInvoke(...args) };',
    );
  }
  try {
    await page.goto(`http://127.0.0.1:${address.port}${nativeFixture ? '?native' : ''}`, {
      waitUntil: 'domcontentloaded',
    });
    console.log('extension app gate: document loaded');
    await page.getByRole('button', { name: '설정', exact: true }).first().click();
    await page.getByRole('tab', { name: /^익스텐션/ }).click();
    await page.getByText('설치한 확장이 없습니다.', { exact: true }).waitFor();
    await page.getByLabel('확장 패키지 파일').setInputFiles(archivePath);
    await page.getByRole('button', { name: '설치', exact: true }).click();
    await page.getByText('v1.0.0', { exact: true }).waitFor();
    if (nativeFixture) {
      // Recreate the manager and rotate the helper token, using the persisted device archive.
      await page.reload();
      await page
        .getByRole('navigation', { name: '연결된 외부 소스' })
        .getByRole('button', { name: /앱 검증용 소스/ })
        .waitFor();
    }
    await page.keyboard.press('Escape');
    await page
      .getByRole('navigation', { name: '연결된 외부 소스' })
      .getByRole('button', { name: /앱 검증용 소스/ })
      .click();
    await page.getByRole('button', { name: 'Synthetic installed novel 작품 상세 열기', exact: true }).waitFor();
    await page.locator('.source-hub-catalog-search input').fill('No matching fixture');
    await page.locator('.source-hub-catalog-search').getByRole('button', { name: '검색', exact: true }).click();
    await page
      .getByRole('button', { name: 'Synthetic installed novel 작품 상세 열기', exact: true })
      .waitFor({ state: 'detached' });
    await page.locator('.source-hub-catalog-search input').fill('Synthetic');
    await page.locator('.source-hub-catalog-search').getByRole('button', { name: '검색', exact: true }).click();
    await page.getByRole('button', { name: '라이브러리 추가', exact: true }).click();
    await page.getByRole('button', { name: '라이브러리 추가됨', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Synthetic installed novel 작품 상세 열기', exact: true }).click();
    await page.getByText('First chapter', { exact: true }).first().waitFor();
    await page.screenshot({ path: resolve(output, 'releases.png'), fullPage: true });
    const titles = await page.locator('.source-hub-release-copy strong').allTextContents();
    if (JSON.stringify(titles) !== JSON.stringify(['First chapter', 'Second chapter']))
      throw new Error('release order changed');
    await page.getByLabel('이 페이지 선택', { exact: true }).check();
    await page.getByRole('button', { name: '선택 회차 다운로드', exact: true }).click();
    await page.waitForFunction(async () => {
      const fixture = (
        globalThis as unknown as {
          extensionAppFixture: { reader: { listNovels(): Promise<{ totalChapters: number }[]> } };
        }
      ).extensionAppFixture;
      return (await fixture.reader.listNovels()).some((book) => book.totalChapters === 2);
    });
    await page.locator('.source-hub-release-row[data-state="imported"]').nth(1).waitFor();
    // The source screen remaining visible proves that batch completion did not open a chapter.
    const before = await page.evaluate(async () =>
      (globalThis as unknown as { extensionAppFixture: ExtensionAppFixture }).extensionAppFixture.inspect(),
    );
    if (
      before.length !== 1 ||
      before[0].bodies.length !== 2 ||
      before[0].bodies.some(
        (body, index) => body !== `Original ${index === 0 ? 'one' : 'two'} chapter.\r\n\r\n  Preserved indentation.\n`,
      )
    )
      throw new Error('imported text or source order changed');
    await page.getByRole('button', { name: 'First chapter 보기', exact: true }).click();
    await page.locator('.reader-screen').waitFor();
    await page.getByText('Original one chapter.', { exact: true }).waitFor();
    const readerElement = await page.locator('.reader-screen').elementHandle();
    await page.mouse.click(683, 500);
    await page.getByRole('button', { name: '읽기 설정 열기', exact: true }).first().click();
    await page.getByRole('tab', { name: /^익스텐션/ }).click();
    await page.getByLabel('확장 패키지 파일').setInputFiles(updatePath);
    await page.getByRole('button', { name: '업데이트', exact: true }).click();
    await page.getByText('v1.0.1', { exact: true }).waitFor();
    const panel = page.getByRole('region', { name: '설치형 확장', exact: true });
    await panel.getByText('관리', { exact: true }).click();
    await panel.getByRole('button', { name: '확장 제거', exact: true }).click();
    await page.getByText('설치한 확장이 없습니다.', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    if (!(await readerElement!.evaluate((element) => element.isConnected)))
      throw new Error('extension lifecycle remounted the Reader');
    await page.getByText('Original one chapter.', { exact: true }).waitFor();
    const after = await page.evaluate(async () =>
      (globalThis as unknown as { extensionAppFixture: ExtensionAppFixture }).extensionAppFixture.inspect(),
    );
    if (
      JSON.stringify(before[0].bodies) !== JSON.stringify(after[0].bodies) ||
      JSON.stringify(before[0].chapters) !== JSON.stringify(after[0].chapters)
    )
      throw new Error('extension lifecycle altered library content');
    if (!(await page.getByRole('button', { name: '다음 화', exact: true }).first().isVisible()))
      await page.mouse.click(683, 500);
    await page.getByRole('button', { name: '다음 화', exact: true }).first().click();
    await page.getByText('Original two chapter.', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(output, 'reader-after-removal-390.png'), fullPage: true, timeout: 10000 });
    await page.setViewportSize({ width: 1366, height: 1000 });
    await page.reload();
    await page.getByRole('button', { name: '설정', exact: true }).first().waitFor();
    const reopened = await page.evaluate(async () =>
      (globalThis as unknown as { extensionAppFixture: ExtensionAppFixture }).extensionAppFixture.inspect(),
    );
    if (JSON.stringify(after[0].bodies) !== JSON.stringify(reopened[0]?.bodies))
      throw new Error('library did not survive reload');
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(
      JSON.stringify({
        passed: true,
        target: nativeFixture ? 'device (bundled runtime, browser lifecycle adapter)' : 'hosted',
        output,
        coverage:
          'production App install, sorted batch import, raw bytes, Reader, update/remove without remount, next chapter after removal, reload persistence',
        pageErrors: errors.length,
      }),
    );
  } catch (error) {
    await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true, timeout: 10000 });
    await writeFile(resolve(output, 'failure.txt'), await page.locator('body').innerText());
    console.error(JSON.stringify({ output, errors, body: (await page.locator('body').innerText()).slice(-7000) }));
    throw error;
  } finally {
    await browser.close();
    await stopHelper();
    await app.close();
  }
}
if (nativeFixture) await runAppGate();
else {
  const harness = await startPostgresIntegrationHarness();
  if (!harness) throw new Error('PostgreSQL is required for the extension app gate');
  try {
    await withPostgresSchema(harness, 'extension_app_browser', runAppGate);
  } finally {
    await harness.stop();
  }
}
