import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
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
const evidence = {
  nativeWindow: false,
  serverReady: false,
  collectorGateway: false,
  sharingRevoked: false,
  restart: false,
};
let app;
let browser;
let page;
let connection;
async function launch() {
  console.log('Starting native app');
  app = spawn(executable, [], {
    env: {
      ...process.env,
      MOYA_EMBEDDED_PROFILE: profile,
      MOYA_EMBEDDED_CDP_PORT: String(port),
      WEBVIEW2_USER_DATA_FOLDER: path.join(profile, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  app.stderr.on('data', (bytes) => console.error(bytes.toString()));
  let connectionError;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    assert.equal(app.exitCode, null, 'Native app exited before showing a reader');
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 });
      break;
    } catch (error) {
      connectionError = error.message;
      await delay(300);
    }
  }
  assert(browser, `WebView2 debugging endpoint unavailable: ${connectionError}`);
  console.log('WebView2 connection established');
  const context = browser.contexts()[0];
  while (!context.pages().length && Date.now() < deadline) await delay(100);
  page = context.pages()[0];
  await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__), { timeout: 30_000 });
  await page
    .getByRole('button', { name: '다른 기기 접속', exact: true })
    .waitFor({ timeout: 90_000 })
    .catch(async (error) => {
      console.error('Native startup screen:', (await page.locator('body').innerText()).slice(0, 2000));
      throw error;
    });
  console.log('Shared reader is ready');
  evidence.nativeWindow = true;
  connection = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('desktop_embedded_server_status'));
  assert.equal(connection.phase, 'ready');
  evidence.serverReady = true;
  const collectorHealth = await page.evaluate(async ({ url, authToken }) => {
    const response = await fetch(`${url}/api/integrations/webnovel-metadata/health`, {
      headers: { Authorization: `Bearer ${authToken}` },
      credentials: 'omit',
    });
    return { status: response.status, body: await response.json() };
  }, connection);
  assert.equal(collectorHealth.status, 200, 'Native WebView could not reach the managed collector gateway');
  assert.equal(collectorHealth.body.service, 'webnovel-metadata-collector');
  evidence.collectorGateway = true;
}
async function close(fromTray = false) {
  const exited = new Promise((resolve) => app.once('exit', resolve));
  if (fromTray) {
    await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke('desktop_embedded_server_close', { keepRunning: false }),
    );
  } else {
    await page.getByRole('button', { name: '창 닫기', exact: true }).click();
    await page.getByRole('button', { name: '서버와 모야 종료', exact: true }).click();
  }
  await Promise.race([
    exited,
    delay(60_000, undefined, { ref: false }).then(() => {
      throw new Error('App shutdown timed out');
    }),
  ]);
  assert.equal(app.exitCode, 0);
  browser = undefined;
  await assert.rejects(readFile(path.join(profile, 'server.lock')), { code: 'ENOENT' });
}
try {
  await launch();
  await page.evaluate(async ({ url, authToken }) => {
    const request = async (resource, options = {}) => {
      const response = await fetch(`${url}/api${resource}`, {
        ...options,
        headers: { Authorization: `Bearer ${authToken}`, ...options.headers },
      });
      if (!response.ok) throw new Error(`Native import failed: ${response.status}`);
      return response.json();
    };
    const bytes = new TextEncoder().encode('1화 시작\n\n앱 창에서 내장 서버의 작품을 읽습니다.\n');
    const upload = await request('/uploads/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: '앱 연결 검증.txt',
        sizeBytes: bytes.length,
        contentType: 'text/plain',
        encoding: 'utf-8',
        chapterSplitMode: 'auto',
        totalChunks: 1,
      }),
    });
    await request(`/uploads/${upload.uploadId}/chunks/0`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    const job = await request(`/uploads/${upload.uploadId}/complete`, { method: 'POST' });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = await request(`/import-jobs/${job.jobId}`);
      if (result.status === 'done') return;
      if (result.status === 'failed') throw new Error('Native import job failed');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Native import timed out');
  }, connection);
  await page.reload();
  await page.getByText('앱 연결 검증', { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.locator('.book-continue-action').first().click();
  await page.getByText('앱 창에서 내장 서버의 작품을 읽습니다.', { exact: false }).first().waitFor();
  evidence.nativeReader = true;
  await page.getByRole('button', { name: '다른 기기 접속', exact: true }).click();
  await page.getByLabel('아이디', { exact: true }).fill('desktop-proof');
  await page.getByLabel('비밀번호', { exact: true }).fill('desktop proof account password');
  await page.getByLabel('비밀번호 확인', { exact: true }).fill('desktop proof account password');
  await page.getByRole('button', { name: '계정 만들기', exact: true }).click();
  await page.getByRole('button', { name: '다른 기기 접속 허용', exact: true }).waitFor();
  assert.equal(await page.getByLabel('접속 방식', { exact: true }).inputValue(), 'cloudflare');
  if (connection.interfaces?.length) {
    await page.getByLabel('접속 방식', { exact: true }).selectOption('direct');
    await page.getByRole('button', { name: '다른 기기 접속 허용', exact: true }).click();
    const address = page.getByLabel('다른 기기 접속 주소');
    await address.waitFor();
    const url = await address.inputValue();
    await page.getByRole('img', { name: '서재 접속 QR 코드' }).waitFor();
    await page.screenshot({ path: path.join(profile, 'native-sharing.png') });
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
  await page.getByText('앱 연결 검증', { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('desktop_embedded_server_close', { keepRunning: true }));
  assert.equal((await fetch(`${connection.url}/api/ready`)).status, 200);
  evidence.trayMaintainsServer = true;
  evidence.restart = true;
  await close(true);
} catch (error) {
  evidence.failure = error.message;
  if (process.platform === 'win32') {
    try {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $bitmap.Save($env:MOYA_TEST_SCREENSHOT)
        $graphics.Dispose()
        $bitmap.Dispose()
        Get-Process -Id ${app.pid} | Select-Object Id,MainWindowTitle,MainWindowHandle,Responding | ConvertTo-Json
      `,
        ],
        {
          env: { ...process.env, MOYA_TEST_SCREENSHOT: path.join(profile, 'native-desktop-error.png') },
          stdio: 'inherit',
          timeout: 10_000,
        },
      );
    } catch {
      /* Preserve the original failure if the desktop cannot be captured. */
    }
  }
  await page?.screenshot({ path: path.join(profile, 'native-error.png'), timeout: 5000 }).catch(() => {});
  throw error;
} finally {
  if (app && app.exitCode === null && page) {
    await page
      .evaluate(() => window.__TAURI_INTERNALS__.invoke('desktop_embedded_server_close', { keepRunning: false }))
      .catch(() => {});
  }
  // A failed browser probe must not leave this isolated test app keeping CI alive.
  if (app && app.exitCode === null) {
    await Promise.race([new Promise((resolve) => app.once('exit', resolve)), delay(15_000, undefined, { ref: false })]);
    if (app.exitCode === null) app.kill();
  }
  await browser?.close().catch(() => {});
  await writeFile(path.join(profile, 'app-smoke-result.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ ...evidence, profile }, null, 2));
