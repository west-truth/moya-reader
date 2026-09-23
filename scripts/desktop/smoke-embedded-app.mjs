import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const executable = path.resolve(process.argv[2]);
const profile = await mkdtemp(path.join(tmpdir(), 'Moya app proof 한글 '));
const listener = createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const evidence = { nativeWindow: false, serverReady: false, sharingRevoked: false, restart: false };
let app;
let browser;
let page;
let connection;
async function launch() {
  app = spawn(executable, [], {
    env: {
      ...process.env,
      MOYA_EMBEDDED_PROFILE: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    assert.equal(app.exitCode, null, 'Native app exited before showing a reader');
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 });
      break;
    } catch {
      await delay(300);
    }
  }
  assert(browser, 'WebView2 debugging endpoint unavailable');
  const context = browser.contexts()[0];
  while (!context.pages().length && Date.now() < deadline) await delay(100);
  page = context.pages()[0];
  await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__), { timeout: 30_000 });
  await page.getByRole('button', { name: '다른 기기 접속', exact: true }).waitFor({ timeout: 90_000 });
  evidence.nativeWindow = true;
  connection = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('desktop_embedded_server_status'));
  assert.equal(connection.phase, 'ready');
  evidence.serverReady = true;
}
async function close() {
  const exited = new Promise((resolve) => app.once('exit', resolve));
  await page.getByRole('button', { name: '창 닫기', exact: true }).click();
  await page.getByRole('button', { name: '서버와 모야 종료', exact: true }).click();
  await Promise.race([
    exited,
    delay(60_000).then(() => {
      throw new Error('App shutdown timed out');
    }),
  ]);
  assert.equal(app.exitCode, 0);
  browser = undefined;
  await assert.rejects(readFile(path.join(profile, 'server.lock')), { code: 'ENOENT' });
}
try {
  await launch();
  await page.getByRole('button', { name: '다른 기기 접속', exact: true }).click();
  await page.getByLabel('아이디', { exact: true }).fill('desktop-proof');
  await page.getByLabel('비밀번호', { exact: true }).fill('desktop proof account password');
  await page.getByLabel('비밀번호 확인', { exact: true }).fill('desktop proof account password');
  await page.getByRole('button', { name: '계정 만들기', exact: true }).click();
  await page.getByRole('button', { name: '다른 기기 접속 허용', exact: true }).waitFor();
  if (connection.interfaces?.length) {
    await page.getByRole('button', { name: '다른 기기 접속 허용', exact: true }).click();
    const address = page.getByLabel('다른 기기 접속 주소');
    await address.waitFor();
    const url = await address.inputValue();
    assert.equal((await fetch(`${url}/api/books`)).status, 401);
    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'desktop-proof', password: 'desktop proof account password' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${url}/api/books`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal(
      (await fetch(`${url}/api/books`, { headers: { Authorization: `Bearer ${connection.authToken}` } })).status,
      403,
    );
    await page.getByRole('button', { name: '다른 기기 접속 해제', exact: true }).click();
    await page.getByRole('button', { name: '다른 기기 접속 허용', exact: true }).waitFor();
    await assert.rejects(fetch(`${url}/api/books`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(2000) }));
    assert.equal((await fetch(`${connection.url}/api/ready`)).status, 200);
    evidence.sharingRevoked = true;
  }
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.screenshot({ path: path.join(profile, 'native-reader.png') });
  const firstUrl = connection.url;
  await close();
  await launch();
  assert.equal(connection.url, firstUrl);
  assert.equal(connection.sharingUrl, null);
  evidence.restart = true;
  await close();
} finally {
  if (app && app.exitCode === null && page) {
    await page
      .evaluate(() => window.__TAURI_INTERNALS__.invoke('desktop_embedded_server_close', { keepRunning: false }))
      .catch(() => {});
  }
  await writeFile(path.join(profile, 'app-smoke-result.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ ...evidence, profile }, null, 2));
