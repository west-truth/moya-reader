import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GoogleDriveFixture } from '../../src/cloud-vault/test-support/google-drive-fixture.ts';
import { AuthStore } from './store.mjs';
import { createAuthServer } from './app.mjs';
import { googleProvider, driveScope } from './google.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = resolve(root, 'apps/web/dist');
const artifacts = resolve(root, `.tmp/web-auth-browser-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
const { base } = JSON.parse(await readFile(resolve(dist, 'offline-manifest.json'), 'utf8'));
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
};
const web = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = resolve(dist, decodeURIComponent(url.pathname.slice(base.length)) || 'index.html');
  if (!url.pathname.startsWith(base) || !path.startsWith(dist + sep)) return res.writeHead(404).end();
  try {
    res.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' }).end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => web.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${web.address().port}`;
const keys = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'fixture', alg: 'RS256', use: 'sig' };
const sign = (nonce) =>
  new SignJWT({ nonce, email: 'reader@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
    .setSubject('reader')
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer('https://accounts.google.com')
    .setAudience('fixture-client')
    .sign(keys.privateKey);
let refreshes = 0,
  logins = 0,
  consents = 0;
const config = {
  clientId: 'fixture-client',
  clientSecret: 'synthetic-only',
  publicUrl: 'http://localhost:1432',
  origins: [origin],
};
const google = googleProvider(
  config,
  async (_url, init) => {
    const body = new URLSearchParams(init.body);
    if (body.get('grant_type') === 'authorization_code') {
      consents++;
      assert.ok(body.get('code_verifier'));
      return Response.json({
        access_token: 'fixture-access',
        refresh_token: 'fixture-refresh',
        expires_in: 3600,
        scope: `openid email ${driveScope}`,
        id_token: await sign(body.get('code')),
      });
    }
    refreshes++;
    assert.equal(body.get('refresh_token'), 'fixture-refresh');
    return Response.json({ access_token: `fixture-renewed-${refreshes}`, expires_in: 3600, scope: driveScope });
  },
  async () => keys.publicKey,
);
const key = randomBytes(32).toString('base64');
let store, auth, context;
async function startAuth(port = 0) {
  store = new AuthStore(resolve(artifacts, 'auth.sqlite'), key);
  auth = createAuthServer({ config, store, google });
  await new Promise((done) => auth.listen(port, '127.0.0.1', done));
  config.publicUrl = `http://127.0.0.1:${auth.address().port}`;
}
await startAuth();
const drive = new GoogleDriveFixture();
const errors = [];
async function startBrowser() {
  context = await chromium.launchPersistentContext(resolve(artifacts, 'profile'), {
    channel: 'msedge',
    headless: true,
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript(
    ({ clientId, authUrl }) =>
      Object.assign(globalThis, {
        __MOYA_RUNTIME_CONFIG__: { schemaVersion: 1, googleDriveClientId: clientId, googleAuthUrl: authUrl },
      }),
    { clientId: config.clientId, authUrl: config.publicUrl },
  );
  await context.exposeBinding('fixtureCredential', async (_source, nonce) => {
    logins++;
    return sign(nonce);
  });
  await context.route('https://accounts.google.com/gsi/client', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `let options; window.google = { accounts: { id: {
    initialize: o => options = o, disableAutoSelect() {}, renderButton(el) { const b=document.createElement('button'); b.textContent='Google로 로그인'; b.onclick=async()=>options.callback({credential:await window.fixtureCredential(options.nonce)}); el.replaceChildren(b); }
  }, oauth2: {} } };`,
    }),
  );
  await context.route('https://www.googleapis.com/oauth2/v3/certs', (route) =>
    route.fulfill({ json: { keys: [jwk] } }),
  );
  await context.route('https://accounts.google.com/o/oauth2/v2/auth?*', (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      status: 302,
      headers: {
        location: `${config.publicUrl}/oauth/callback?state=${url.searchParams.get('state')}&code=${url.searchParams.get('nonce')}`,
      },
      body: '',
    });
  });
  await context.route(/https:\/\/www\.googleapis\.com\/(upload\/)?drive\//, async (route) => {
    const req = route.request();
    const res = await drive.fetch(req.url(), {
      method: req.method(),
      headers: req.headers(),
      body: req.postDataBuffer(),
    });
    await route.fulfill({
      status: res.status,
      headers: {
        ...Object.fromEntries(res.headers),
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'ETag, Location, Range',
      },
      body: Buffer.from(await res.arrayBuffer()),
    });
  });
  const page = context.pages()[0];
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + base);
  await page.getByRole('button', { name: '책 가져오기', exact: true }).waitFor();
  return page;
}
try {
  let page = await startBrowser();
  await page.getByRole('button', { name: '책 가져오기', exact: true }).click();
  await page
    .locator('input[type=file]')
    .setInputFiles({
      name: 'Persistent auth.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('제1화 시작\n\n브라우저 재시작을 확인하는 합성 소설입니다.\n'),
    });
  await page.getByRole('button', { name: '가져오기 시작', exact: true }).click();
  await page.getByRole('button', { name: '첫 화 보기', exact: true }).first().waitFor();
  await page.getByRole('button', { name: /동기화 열기/ }).click();
  await page.getByRole('button', { name: 'Google로 로그인', exact: true }).click();
  await page
    .getByRole('region', { name: /^Google/ })
    .getByText('reader@example.test', { exact: true })
    .waitFor();
  const account = page.getByRole('region', { name: 'Google 계정과 동기화' });
  await account.getByLabel(/^동기화 암호/).fill('synthetic-passphrase');
  await account.getByRole('checkbox').check();
  await account.locator('input[type=checkbox]:checked').waitFor();
  await account.getByRole('button', { name: 'Google Drive 동기화 켜기' }).click();
  await page.getByText(/마지막 동기화/).waitFor();
  assert.ok([...drive.files.values()].some((file) => file.appProperties.moyaObject?.startsWith('content/')));
  await page.reload();
  await page.getByRole('button', { name: /동기화 열기/ }).click();
  await page
    .getByRole('region', { name: /^Google/ })
    .getByText('reader@example.test', { exact: true })
    .waitFor();
  await page.getByText(/Google Drive에 연결됐어요/).waitFor();
  await context.close();
  context = undefined;
  const port = auth.address().port;
  await new Promise((done) => auth.close(done));
  store.close();
  await startAuth(port);
  page = await startBrowser();
  await page.getByRole('button', { name: /동기화 열기/ }).click();
  await page
    .getByRole('region', { name: /^Google/ })
    .getByText('reader@example.test', { exact: true })
    .waitFor();
  await page.getByText(/Google Drive에 연결됐어요/).waitFor();
  await page.getByText(/마지막 동기화/).waitFor();
  // Wait for the startup sync to actually request a renewed grant after server memory was cleared.
  for (let i = 0; refreshes === 0 && i < 50; i++) await new Promise((done) => setTimeout(done, 100));
  assert.ok(refreshes > 0);
  assert.equal(logins, 1);
  assert.equal(consents, 1);
  await page.screenshot({ path: resolve(artifacts, 'restored.png'), fullPage: true });
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await page.getByRole('button', { name: 'Google로 로그인', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: /동기화 열기/ }).click();
  await page.getByRole('button', { name: 'Google로 로그인', exact: true }).waitFor();
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(
    JSON.stringify({
      result: 'PASS',
      syntheticGoogle: true,
      realAuthServer: true,
      reload: true,
      browserAndServerRestart: true,
      automaticRefresh: true,
      logoutPersists: true,
      logins,
      consents,
      refreshes,
      pageErrors: 0,
    }),
  );
} catch (error) {
  if (context?.pages()[0])
    await context.pages()[0].screenshot({ path: resolve(artifacts, 'failed.png'), fullPage: true });
  throw error;
} finally {
  await context?.close();
  await new Promise((done) => auth.close(done));
  store.close();
  await new Promise((done) => web.close(done));
}
