import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GoogleDriveFixture } from '../../../src/cloud-vault/test-support/google-drive-fixture';

// Runs the real production App/Google verifier/Vault with synthetic Google services, not a live-account claim.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dist = resolve(root, 'apps/web/dist');
const artifacts = resolve(root, '.tmp/web-google-check');
await mkdir(artifacts, { recursive: true });
const { base } = JSON.parse(await readFile(resolve(dist, 'offline-manifest.json'), 'utf8'));
const mime: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};
const server = createServer(async (request, response) => {
  const url = new URL(request.url!, 'http://localhost');
  const file = resolve(dist, decodeURIComponent(url.pathname.slice(base.length)) || 'index.html');
  if (!url.pathname.startsWith(base) || !file.startsWith(dist + sep)) {
    response.writeHead(404).end();
    return;
  }
  try {
    response
      .writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' })
      .end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ channel: process.env.READER_UI_BROWSER_CHANNEL || 'msedge', headless: true });
const keys = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'fixture', alg: 'RS256', use: 'sig' };
const drive = new GoogleDriveFixture();
const errors: string[] = [];
const sdk = `let options; window.google = { accounts: {
  id: { initialize: o => options = o, disableAutoSelect() {}, renderButton(el) {
    const button = document.createElement('button'); button.textContent = 'Google로 로그인';
    button.onclick = async () => options.callback({ credential: await window.fixtureCredential(options.nonce) });
    el.replaceChildren(button);
  } },
  oauth2: { initTokenClient(o) { return { requestAccessToken() {
    if (window.fixtureDeny) o.callback({ error: 'access_denied' });
    else o.callback({ access_token: 'fixture-token', scope: o.scope, expires_in: 3600 });
  } }; } }
} };`;

async function configure(context: BrowserContext, subject = 'reader') {
  await context.addInitScript(() => {
    Object.assign(globalThis, { __MOYA_RUNTIME_CONFIG__: { schemaVersion: 1, googleDriveClientId: 'fixture-client' } });
  });
  await context.exposeBinding('fixtureCredential', async (_source, nonce: string) =>
    new SignJWT({ nonce, email: `${subject}@example.test` })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer('https://accounts.google.com')
      .setAudience('fixture-client')
      .sign(keys.privateKey),
  );
  await context.route('https://accounts.google.com/gsi/client', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: sdk }),
  );
  await context.route('https://www.googleapis.com/oauth2/v3/certs', (route) =>
    route.fulfill({ json: { keys: [jwk] } }),
  );
  await context.route('https://openidconnect.googleapis.com/v1/userinfo', (route) =>
    route.fulfill({ json: { sub: subject } }),
  );
  await context.route(/https:\/\/www\.googleapis\.com\/(upload\/)?drive\//, async (route) => {
    const request = route.request();
    const response = await drive.fetch(request.url(), {
      method: request.method(),
      headers: request.headers(),
      body: request.postDataBuffer() as BodyInit | undefined,
    });
    await route.fulfill({
      status: response.status,
      headers: {
        ...Object.fromEntries(response.headers),
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'Location, Range, ETag',
      },
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
}
async function pageFor(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + base);
  await page.getByRole('button', { name: '책 가져오기', exact: true }).waitFor();
  return page;
}
async function openAccount(page: Page) {
  await page.getByRole('button', { name: /동기화 열기/ }).click();
  await page.getByRole('button', { name: 'Google로 로그인', exact: true }).click();
  await page.getByText('reader@example.test', { exact: true }).waitFor();
}
try {
  const first = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await configure(first);
  const page = await pageFor(first);
  await page.getByRole('button', { name: '책 가져오기', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'Google flow.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('제1화 시작\n\nGoogle 동기화를 확인하는 합성 소설입니다.\n\n두 번째 문단입니다.\n'),
  });
  await page.getByRole('button', { name: '가져오기 시작', exact: true }).click();
  await page.getByRole('button', { name: '첫 화 보기', exact: true }).first().click();
  await page.locator('.reader-paragraph').first().waitFor();
  await page.locator('.reader-scroll').click();
  await page.locator('.reader-topbar').getByRole('button', { name: '북마크 추가', exact: true }).click();
  await page.getByRole('button', { name: '화 목록으로', exact: true }).click();
  await page.reload();
  await openAccount(page);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(drive.files.size, 0, 'Login alone must not create or upload a file');
  await page.getByRole('button', { name: '나중에', exact: true }).click();
  assert.equal(drive.files.size, 0);
  await page.getByRole('button', { name: 'Drive 동기화 설정', exact: true }).click();
  const account = page.getByRole('region', { name: 'Google 계정과 동기화' });
  assert.equal(await account.locator('input[type=password]').count(), 0);
  assert.equal(await page.locator('.cloud-vault-section input[type=password]').count(), 0);
  await page.screenshot({ path: resolve(artifacts, 'setup-mobile.png'), fullPage: true });
  await page.evaluate(() => Object.assign(window, { fixtureDeny: true }));
  await account.getByRole('button', { name: 'Google Drive 동기화 켜기' }).click();
  await page.getByText(/Drive 접근이 허용되지 않았습니다/).waitFor();
  assert.equal(drive.files.size, 0, 'Denied Drive consent must not upload files');
  await page.evaluate(() => Object.assign(window, { fixtureDeny: false }));
  await account.getByRole('checkbox').click();
  await account.locator('input[type=checkbox]:checked').waitFor();
  await account.getByRole('button', { name: 'Google Drive 동기화 켜기' }).click();
  await page.getByText(/마지막 동기화/).waitFor();
  assert(
    [...drive.files.values()].some((file) => file.appProperties.moyaObject?.startsWith('content/')),
    'Source-file opt-in uploads originals',
  );
  await page.screenshot({ path: resolve(artifacts, 'connected-mobile.png'), fullPage: true });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    'Mobile page must not overflow',
  );
  await account.getByRole('button', { name: '로그아웃', exact: true }).click();
  await page.getByRole('button', { name: 'Google로 로그인', exact: true }).waitFor();
  await page.getByRole('button', { name: '동기화 패널 닫기', exact: true }).click();
  await page.getByText('Google flow', { exact: true }).filter({ visible: true }).first().waitFor();

  const second = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await configure(second);
  const restored = await pageFor(second);
  await openAccount(restored);
  const secondAccount = restored.getByRole('region', { name: 'Google 계정과 동기화' });
  assert.equal(await secondAccount.locator('input[type=password]').count(), 0);
  await secondAccount.getByRole('checkbox').click();
  await secondAccount.locator('input[type=checkbox]:checked').waitFor();
  await secondAccount.getByRole('button', { name: 'Google Drive 동기화 켜기' }).click();
  await restored.getByText(/마지막 동기화/).waitFor();
  assert.equal(await restored.locator('.cloud-vault-section input[type=password]').count(), 0);
  await restored.getByRole('button', { name: '동기화 패널 닫기', exact: true }).click();
  await restored.getByText('Google flow', { exact: true }).filter({ visible: true }).first().waitFor();
  await restored.getByText('Google flow', { exact: true }).filter({ visible: true }).first().click();
  await restored.getByRole('button', { name: '이어 읽기', exact: true }).first().click();
  await restored.locator('.reader-paragraph').first().waitFor();
  await restored.locator('.reader-scroll').click();
  await restored.locator('.reader-topbar').getByRole('button', { name: '북마크 제거', exact: true }).waitFor();
  assert((await restored.locator('.reader-paragraph').allTextContents()).join('').includes('합성 소설'));
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(
    JSON.stringify({
      result: 'PASS',
      syntheticGoogle: true,
      realGoogleAccount: false,
      loginWithoutUpload: true,
      deniedConsent: true,
      mobile: true,
      sourceOptIn: true,
      noApplicationPassword: true,
      twoProfileRestoreAndRead: true,
      pageErrors: errors.length,
    }),
  );
} catch (error) {
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      await page.screenshot({ path: resolve(artifacts, `failure-${Date.now()}.png`), fullPage: true }).catch(() => {});
    }
  throw error;
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
