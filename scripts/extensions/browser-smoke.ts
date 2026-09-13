import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { EncryptedSourceCredentialVault } from '../../apps/server/src/extensions/source-credential-vault';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const Fastify = require('fastify') as typeof import('../../apps/server/node_modules/fastify').default;
const { build } = require('esbuild') as typeof import('../../apps/server/node_modules/esbuild');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, '.tmp', `extension-install-browser-${Date.now()}`);
await mkdir(output, { recursive: true });
const body = 'Original synthetic chapter.\r\n\r\n  Preserved indentation.\n';
const source = `globalThis.moyaExtension=async(method,input,host)=>{
 if(method==='describe')return{apiVersion:1,sources:[{id:'org.example.catalog.source',cover:false}]};
 if(method==='source.listWorks')return{items:[{id:'work',title:'Synthetic work'}]};
 if(method==='source.getWork')return{id:'work',title:'Synthetic work'};
 if(method==='source.listReleases')return{items:[{id:'one',title:'First chapter',order:1}]};
 if(method==='source.getContent')return{kind:'text',asset:await host.request('asset.fromText',{text:${JSON.stringify(body)}})};
};`;
const baseManifest = examplePackageManifest();
const manifest = {
  ...baseManifest,
  updates: { repository: 'https://catalog.example/extensions/index.json' },
  requestedAccess: {
    ...baseManifest.requestedAccess,
    contentServices: [{ sourceId: 'org.example.catalog.source', version: 1, origins: ['https://catalog.example'] }],
    authentication: [
      {
        sourceId: 'org.example.catalog.source',
        label: '예제 계정 연결',
        origin: 'https://catalog.example',
        scheme: 'cookie',
        cookieName: 'SESSION',
        verification: { path: '/account', field: ['authenticated'], equals: true },
      },
    ],
  },
};
manifest.extension.name = '설치형 텍스트 소스';
const publisherKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
let repositoryVersion = '1.0.2';
for (const version of ['1.0.0', '1.0.1', '1.0.2', '1.0.3']) {
  manifest.extension.version = version;
  const signingKey = version === '1.0.0' ? undefined : publisherKey;
  const archive = await buildMoyaExtension({ manifest, source, license: 'Synthetic fixture license', signingKey });
  await writeFile(resolve(output, `${version}.moyaext`), new Uint8Array(await archive.arrayBuffer()));
}
await build({
  stdin: {
    contents: `
    import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {InstalledExtensionsPanel} from './src/features/extensions/InstalledExtensionsPanel';
    import {RemoteInstalledExtensions} from './src/extensions/packages/remote-installed-extensions';
    import {RemoteApiClient} from './src/services/remote/remote-api-client';
    import './src/styles/tokens.css'; import './src/styles/base.css';
    import './src/features/reader-settings/reader-settings-panel.css';
    const manager=new RemoteInstalledExtensions(new RemoteApiClient('/api',{getAuthToken:()=> 'fixture-token'}));
    void manager.refresh();
    function Fixture(){const [result,setResult]=useState('');return <main style={{maxWidth:720,margin:'20px auto',padding:16}}>
      <InstalledExtensionsPanel manager={manager}/><button onClick={async()=>{
        const id='org.example.catalog.source',ctx={brokers:{get:()=>undefined}},signal=new AbortController().signal;
        const page=await manager.listExternalSource(id,ctx,{parentRef:'work'},signal);const item=page.items[0];
        const value=await manager.downloadExternalSource(id,ctx,{key:item.key,fileName:item.importFileName},signal);
        setResult(await value.content.file.text());
      }}>회차 확인</button><pre data-testid="chapter">{result}</pre></main>}
    createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: root,
    loader: 'tsx',
    sourcefile: 'extension-install-fixture.tsx',
  },
  bundle: true,
  write: true,
  outfile: resolve(output, 'fixture.js'),
  jsx: 'automatic',
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});
const harness = await startPostgresIntegrationHarness();
if (!harness) throw new Error('PostgreSQL is required for the extension browser gate');
try {
  await withPostgresSchema(harness, 'extension_browser', async (pool) => {
    await pool.query('create table users(id text primary key)');
    await pool.query("insert into users(id) values ('fixture-owner')");
    await pool.query(
      await readFile(resolve(root, 'apps/server/src/db/migrations/0046_extension_packages.sql'), 'utf8'),
    );
    await pool.query(
      await readFile(resolve(root, 'apps/server/src/db/migrations/0047_extension_source_state.sql'), 'utf8'),
    );
    await pool.query(
      await readFile(resolve(root, 'apps/server/src/db/migrations/0048_extension_repositories.sql'), 'utf8'),
    );
    const app = Fastify();
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, bytes, done) =>
      done(null, bytes),
    );
    // Only fixture assets are public. Product API uses the real authentication hook.
    await app.register(async (secured) => {
      await registerAuthHook(secured, { host: '127.0.0.1', authToken: 'fixture-token' } as ServerConfig);
      await registerExtensionPackageRoutes(
        secured,
        new PostgresPackageInstallStore(pool, 'fixture-owner'),
        createNodePackageExecution('self-host-gateway', {
          vault: new EncryptedSourceCredentialVault(resolve(output, 'credentials'), randomBytes(32)),
          transport: {
            lookup: async () => [{ address: '93.184.216.34', family: 4 }],
            transport: async ({ url }, input) => {
              const archive = await readFile(resolve(output, `${repositoryVersion}.moyaext`));
              const bytes =
                url.pathname === '/account'
                  ? Buffer.from(JSON.stringify({ authenticated: input.headers.cookie === 'SESSION=fixture-session' }))
                  : url.pathname.endsWith('index.json')
                    ? Buffer.from(
                        JSON.stringify({
                          format: 'moya.extension.repository',
                          version: 1,
                          name: '예제 확장 저장소',
                          packages: [
                            {
                              id: manifest.extension.id,
                              name: '저장소 텍스트 소스',
                              version: repositoryVersion,
                              archive: './catalog.moyaext',
                              sha256: createHash('sha256').update(archive).digest('hex'),
                            },
                          ],
                        }),
                      )
                    : archive;
              return { status: 200, headers: {}, body: Readable.from([bytes]) };
            },
          },
        }),
      );
    });
    app.get('/', (_request, reply) =>
      reply
        .type('text/html')
        .send(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
        ),
    );
    for (const name of ['fixture.js', 'fixture.css'])
      app.get(`/${name}`, async (_request, reply) =>
        reply
          .type(name.endsWith('js') ? 'application/javascript' : 'text/css')
          .send(await readFile(resolve(output, name))),
      );
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
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
      await page.getByText('설치한 확장이 없습니다.', { exact: true }).waitFor();
      for (const [version, action] of [
        ['1.0.0', '설치'],
        ['1.0.1', '업데이트'],
      ]) {
        await page.getByLabel('확장 패키지 파일').setInputFiles(resolve(output, `${version}.moyaext`));
        await page.getByRole('button', { name: action, exact: true }).waitFor();
        const acknowledgement = page.getByLabel('위 변경 사항을 확인했습니다');
        if (await acknowledgement.count()) {
          if (!(await page.getByRole('button', { name: action, exact: true }).isDisabled()))
            throw new Error('publisher review bypass');
          await acknowledgement.check();
        }
        await page.screenshot({ path: resolve(output, `review-${version}-390.png`), fullPage: true });
        await page.getByRole('button', { name: action, exact: true }).click();
        await page.getByText(`v${version}`, { exact: true }).waitFor();
      }
      await page.getByRole('button', { name: '회차 확인', exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="chapter"]')?.textContent?.includes('Preserved indentation'),
      );
      if ((await page.getByTestId('chapter').textContent()) !== body) throw new Error('source bytes changed');
      await page.getByText('예제 계정 연결', { exact: true }).click();
      await page.getByText('저장된 연결이 없습니다.', { exact: true }).waitFor();
      await page.getByLabel('SESSION 쿠키 값').fill('fixture-session');
      await page.getByRole('button', { name: '확인 후 저장', exact: true }).click();
      await page.getByText('인증을 확인했습니다.', { exact: true }).waitFor();
      if (await page.getByLabel('SESSION 쿠키 값').inputValue()) throw new Error('credential retained in form');
      await page.getByLabel('SESSION 쿠키 값').fill('wrong-session');
      await page.getByRole('button', { name: '확인 후 저장', exact: true }).click();
      await page.getByText('인증을 확인하지 못했습니다.', { exact: false }).waitFor();
      await page.getByRole('button', { name: '연결 확인', exact: true }).click();
      await page.getByText('인증을 확인했습니다.', { exact: true }).waitFor();
      await page.getByText('관리', { exact: true }).click();
      await page.getByRole('button', { name: '업데이트 확인', exact: true }).click();
      await page.getByRole('button', { name: '업데이트', exact: true }).waitFor();
      await page.screenshot({ path: resolve(output, 'repository-review-390.png'), fullPage: true });
      await page.getByRole('button', { name: '업데이트', exact: true }).click();
      await page.getByText('v1.0.2', { exact: true }).waitFor();
      await page.getByText('예제 계정 연결', { exact: true }).click();
      await page.getByText('연결이 저장돼 있습니다.', { exact: false }).waitFor();
      await page.getByRole('button', { name: '업데이트 확인', exact: true }).click();
      await page.getByText('새 버전이 없습니다.', { exact: true }).waitFor();
      for (const width of [390, 768, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        if (overflow) throw new Error(`horizontal overflow at ${width}`);
        await page.screenshot({ path: resolve(output, `installed-${width}.png`), fullPage: true });
      }
      await page.reload();
      await page.getByText('v1.0.2', { exact: true }).waitFor();
      await page.getByText('예제 계정 연결', { exact: true }).click();
      await page.getByText('연결이 저장돼 있습니다.', { exact: false }).waitFor();
      await page.getByText('관리', { exact: true }).click();
      await page.getByRole('button', { name: '이전 버전 복원', exact: true }).click();
      await page.getByText('v1.0.1', { exact: true }).waitFor();
      await page.getByRole('button', { name: '확장 제거', exact: true }).click();
      await page.getByText('설치한 확장이 없습니다.', { exact: true }).waitFor();
      if (errors.length) throw new Error(errors.join('\n'));
      await page.getByRole('button', { name: '저장소', exact: true }).click();
      await page.getByLabel('저장소 주소', { exact: true }).fill('https://catalog.example/extensions/index.json');
      await page.getByRole('button', { name: '저장소 추가', exact: true }).click();
      await page.getByText('저장소 텍스트 소스', { exact: true }).waitFor();
      await page.getByLabel('확장 검색', { exact: true }).fill('존재하지 않는 검색');
      await page.getByText('표시할 확장이 없습니다.', { exact: true }).waitFor();
      await page.getByLabel('확장 검색', { exact: true }).fill('텍스트');
      for (const width of [390, 768, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1))
          throw new Error(`repository overflow ${width}`);
        await page.screenshot({ path: resolve(output, `repository-browse-${width}.png`), fullPage: true });
      }
      await page.getByRole('button', { name: '설치 검토', exact: true }).click();
      await page.getByRole('button', { name: '설치', exact: true }).click();
      await page.getByText('v1.0.2', { exact: true }).waitFor();
      await page.reload();
      await page.getByRole('button', { name: '저장소', exact: true }).click();
      await page.getByText('저장소 텍스트 소스', { exact: true }).waitFor();
      repositoryVersion = '1.0.3';
      await page.getByLabel('업데이트만 표시').check();
      await page.getByText('표시할 확장이 없습니다.', { exact: true }).waitFor();
      await page.getByRole('button', { name: '목록·업데이트 확인', exact: true }).click();
      await page.getByRole('button', { name: '업데이트 검토', exact: true }).click();
      await page.getByRole('button', { name: '업데이트', exact: true }).click();
      await page.getByText('v1.0.3', { exact: true }).waitFor();
      await page.getByRole('button', { name: '저장소', exact: true }).click();
      await page.getByText('저장소 텍스트 소스', { exact: true }).waitFor();
      await page.getByRole('button', { name: '저장소 삭제', exact: true }).click();
      await page.getByText('저장소 텍스트 소스', { exact: true }).waitFor({ state: 'detached' });
      await page.getByText('v1.0.3', { exact: true }).waitFor();
      if (errors.length) throw new Error(errors.join('\n'));
      console.log(
        JSON.stringify({
          output,
          passed: true,
          widths: [390, 768, 1024],
          flow: 'inspect/install/authenticate/update/rollback/remove/repository-add/search/install/reload/cache/update-filter/update/repository-remove',
          pageErrors: errors.length,
        }),
      );
    } finally {
      await browser.close();
      await app.close();
    }
  });
} finally {
  await harness.stop();
}
