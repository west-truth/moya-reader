import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import { startEmbeddedServer } from './embedded-server.mjs';
import { epubFixture, pdfFixture } from './embedded-format-fixtures.mjs';

const executable = path.resolve(process.argv[2]);
const profile = await mkdtemp(path.join(tmpdir(), 'Moya app proof 한글 '));
const listener = createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const evidence = {
  nativeWindow: false,
  serverReady: false,
  nativePeerSettings: false,
  collectorGateway: false,
  nativeFormats: [],
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
  try {
    await Promise.race([
      exited,
      delay(60_000, undefined, { ref: false }).then(() => {
        throw new Error('App shutdown timed out');
      }),
    ]);
  } catch (error) {
    const status = await Promise.race([
      page
        .evaluate(() => window.__TAURI_INTERNALS__.invoke('desktop_embedded_server_status'))
        .then(({ phase, running }) => ({ phase, running }))
        .catch(() => undefined),
      delay(3_000, undefined, { ref: false }).then(() => undefined),
    ]);
    const lifecycle = (await readFile(path.join(profile, 'api.log'), 'utf8').catch(() => ''))
      .split('\n')
      .flatMap((line) => {
        try {
          const record = JSON.parse(line);
          return typeof record.msg === 'string' && record.msg.startsWith('server_shutdown_')
            ? [{ time: record.time, msg: record.msg, signal: record.signal, errorName: record.errorName }]
            : [];
        } catch {
          return [];
        }
      });
    console.error('Native shutdown diagnostics:', JSON.stringify({ status, lifecycle }));
    throw error;
  }
  assert.equal(app.exitCode, 0);
  browser = undefined;
  await assert.rejects(readFile(path.join(profile, 'server.lock')), { code: 'ENOENT' });
}
try {
  await launch();
  await page.getByRole('button', { name: '설정 열기', exact: true }).click();
  await page.getByRole('tab', { name: /앱 정보/ }).click();
  await page.getByRole('heading', { name: '다른 서버의 서재를 이 서버에 보관' }).waitFor();
  await page.getByRole('button', { name: '빈 서재에 복제하고 연결' }).waitFor();
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  evidence.nativePeerSettings = true;
  const textBookId = await page.evaluate(async ({ url, authToken }) => {
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
      if (result.status === 'done') return result.book_id;
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
  const reader = page.locator('.reader-scroll.is-active');
  const readerBounds = await reader.boundingBox();
  assert(readerBounds, 'Native reader viewport is missing');
  await reader.click({ position: { x: readerBounds.width / 2, y: readerBounds.height / 2 } });
  await page.locator('.reader-screen:not(.immersive)').waitFor();
  const mobileSearch = page.getByRole('button', { name: '본문 검색 열기', exact: true });
  if (await mobileSearch.isVisible()) {
    await mobileSearch.click();
    await page.getByLabel('모바일 본문 검색', { exact: true }).fill('내장 서버의 작품');
  } else {
    await page.getByLabel('본문 검색', { exact: true }).fill('내장 서버의 작품');
  }
  await page.getByRole('status').getByText('1개 결과').waitFor();
  evidence.nativeSearch = true;
  if (await mobileSearch.isVisible()) await page.getByRole('button', { name: '본문 검색 닫기' }).click();
  await page.locator('button[aria-label="북마크 추가"]:visible').click();
  await page.locator('button[aria-label="북마크 제거"]:visible').waitFor();
  const bookmarks = await fetch(`${connection.url}/api/books/${textBookId}/bookmarks`, {
    headers: { Authorization: `Bearer ${connection.authToken}` },
  });
  assert.equal(bookmarks.status, 200);
  assert.equal((await bookmarks.json()).bookmarks.length, 1);
  evidence.nativeBookmark = true;
  let pdfBookId;
  for (const [format, bytes, contentType, title] of [
    ['epub', await epubFixture(), 'application/epub+zip', 'Moya EPUB proof'],
    ['pdf', pdfFixture(), 'application/pdf', 'Moya PDF proof'],
  ]) {
    const request = async (resource, options = {}) => {
      const response = await fetch(`${connection.url}/api${resource}`, {
        ...options,
        headers: { Authorization: `Bearer ${connection.authToken}`, ...options.headers },
      });
      assert(response.ok, `${resource}: ${response.status} ${await response.clone().text()}`);
      return response.json();
    };
    const upload = await request('/uploads/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: `${title}.${format}`, sizeBytes: bytes.length, contentType, totalChunks: 1 }),
    });
    await request(`/uploads/${upload.uploadId}/chunks/0`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    const complete = await request(`/uploads/${upload.uploadId}/complete`, { method: 'POST' });
    const deadline = Date.now() + 60_000;
    let job;
    do {
      job = await request(`/import-jobs/${complete.jobId}`);
      assert.notEqual(job.status, 'failed', job.error_message);
      if (job.status !== 'done') await delay(250);
    } while (job.status !== 'done' && Date.now() < deadline);
    assert.equal(job.status, 'done');
    if (format === 'pdf') pdfBookId = job.book_id;
    const source = await fetch(`${connection.url}/api/books/${job.book_id}/source`, {
      headers: { Authorization: `Bearer ${connection.authToken}` },
    });
    assert.equal(source.status, 200);
    assert.deepEqual(Buffer.from(await source.arrayBuffer()), bytes);
    await page.reload();
    await page.locator(`.book-continue-action[aria-label^="${title}"]`).click();
    if (format === 'epub') {
      await page.getByText('Embedded EPUB reading works.', { exact: false }).first().waitFor();
    } else {
      await page.waitForFunction(() => {
        const canvas = document.querySelector('.fixed-doc-pdf-page canvas');
        if (!canvas) return false;
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let dark = false;
        let light = false;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] === 255 && pixels[i] < 100) dark = true;
          if (pixels[i + 3] === 255 && pixels[i] > 200) light = true;
          if (dark && light) return true;
        }
        return false;
      });
    }
    await page.screenshot({ path: path.join(profile, `native-${format}.png`) });
    evidence.nativeFormats.push(format);
  }
  const pdfBookmark = page.locator('button[title="현재 페이지 북마크"]:visible');
  if (await pdfBookmark.count()) await pdfBookmark.click();
  else await page.getByRole('button', { name: '현재 페이지 북마크', exact: true }).click();
  const pdfAnnotationUrl = `${connection.url}/api/books/${pdfBookId}/document-annotations`;
  const annotationHeaders = { Authorization: `Bearer ${connection.authToken}` };
  let pdfAnnotations;
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(pdfAnnotationUrl, { headers: annotationHeaders });
    assert.equal(response.status, 200);
    pdfAnnotations = (await response.json()).annotations;
    if (pdfAnnotations.length === 1) break;
    await delay(100);
  }
  assert.equal(pdfAnnotations.length, 1, 'Native PDF bookmark was not saved to the server');
  assert.equal(pdfAnnotations[0].type, 'page_bookmark');
  evidence.nativeDocumentAnnotation = true;
  await page.reload();
  const saveCapability = await page.evaluate(() => ({
    secureContext: window.isSecureContext,
    picker: typeof window.showSaveFilePicker,
  }));
  assert.deepEqual(saveCapability, { secureContext: true, picker: 'function' });
  await page.evaluate(() => {
    const chunks = [];
    window.__moyaBackupProof = { chunks, saved: false };
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({
        createWritable: async () =>
          new WritableStream({
            write(chunk) {
              chunks.push(chunk.slice());
            },
            close() {
              window.__moyaBackupProof.saved = true;
            },
          }),
      }),
    });
  });
  await page.getByRole('button', { name: '백업 및 복원 열기', exact: true }).click();
  await page.getByRole('button', { name: '백업 만들기', exact: true }).click();
  await page.waitForFunction(() => window.__moyaBackupProof?.saved, undefined, { timeout: 30_000 });
  const backupPath = path.join(profile, 'native-backup.zip');
  const backupBytes = await page.evaluate(async () =>
    Array.from(new Uint8Array(await new Blob(window.__moyaBackupProof.chunks).arrayBuffer())),
  );
  await writeFile(backupPath, Buffer.from(backupBytes));
  const backupReader = new ZipReader(new BlobReader(new Blob([await readFile(backupPath)])));
  try {
    const manifestEntry = (await backupReader.getEntries()).find((entry) => entry.filename === 'manifest.json');
    assert(manifestEntry?.getData, 'Native backup download did not contain a manifest');
    const manifest = JSON.parse(await manifestEntry.getData(new TextWriter()));
    assert.equal(manifest.backend, 'hosted');
    assert.equal(manifest.books.length, 3);
  } finally {
    await backupReader.close();
  }
  evidence.nativeBackupSaved = true;
  await page.getByRole('button', { name: '백업 패널 닫기', exact: true }).click();
  const localBackupPath = path.join(profile, 'previous-local-backup.zip');
  const fixtureScript = path.join(import.meta.dirname, 'create-embedded-local-backup-fixture.ts');
  const tsxCli = path.resolve(import.meta.dirname, '../../apps/server/node_modules/tsx/dist/cli.mjs');
  const localFixture = JSON.parse(
    execFileSync(process.execPath, [tsxCli, fixtureScript, localBackupPath], {
      encoding: 'utf8',
    }),
  );
  await page.getByRole('button', { name: '백업 및 복원 열기', exact: true }).click();
  await page.locator('.backup-dialog input[type="file"]').setInputFiles(localBackupPath);
  await page.getByText('기존 로컬 백업을 서버 저장 형식으로 검증했습니다.', { exact: false }).waitFor();
  await page.getByRole('button', { name: '검사한 백업 복원', exact: true }).click();
  await page.getByRole('button', { name: '백업 패널 닫기', exact: true }).waitFor({ state: 'hidden' });
  const localHeaders = { Authorization: `Bearer ${connection.authToken}` };
  const localManifest = await fetch(`${connection.url}/api/books/${localFixture.bookId}/manifest`, {
    headers: localHeaders,
  });
  assert.equal(localManifest.status, 200);
  assert.equal((await localManifest.json()).readingPosition.scroll_top, 19);
  const localBookmarks = await fetch(`${connection.url}/api/books/${localFixture.bookId}/bookmarks`, {
    headers: localHeaders,
  });
  assert.equal(localBookmarks.status, 200);
  assert.equal((await localBookmarks.json()).bookmarks[0].label, '기존 백업 북마크');
  const localSource = await fetch(`${connection.url}/api/books/${localFixture.bookId}/source`, {
    headers: localHeaders,
  });
  assert.equal(localSource.status, 200);
  assert.deepEqual(Buffer.from(await localSource.arrayBuffer()), Buffer.from(localFixture.source, 'base64'));
  evidence.nativeLocalBackupRestored = true;
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
  const persistedBookmarks = await fetch(`${connection.url}/api/books/${textBookId}/bookmarks`, {
    headers: { Authorization: `Bearer ${connection.authToken}` },
  });
  assert.equal(persistedBookmarks.status, 200);
  assert.equal((await persistedBookmarks.json()).bookmarks.length, 1);
  const persistedPdfAnnotations = await fetch(pdfAnnotationUrl, {
    headers: { Authorization: `Bearer ${connection.authToken}` },
  });
  assert.equal(persistedPdfAnnotations.status, 200);
  assert.equal((await persistedPdfAnnotations.json()).annotations.length, 1);
  evidence.nativeBookmarkRestart = true;
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('desktop_embedded_server_close', { keepRunning: true }));
  assert.equal((await fetch(`${connection.url}/api/ready`)).status, 200);
  evidence.trayMaintainsServer = true;
  evidence.restart = true;
  await close(true);
  const restoredProfile = await mkdtemp(path.join(tmpdir(), 'Moya native backup restored '));
  const runtimeFile = path.join(path.dirname(executable), 'embedded-server', 'runtime.json');
  let restoredServer;
  try {
    restoredServer = await startEmbeddedServer({ runtimeFile, profileDir: restoredProfile });
    const restoredRequest = async (resource, options = {}) => {
      const response = await fetch(`${restoredServer.url}/api${resource}`, {
        ...options,
        headers: { Authorization: `Bearer ${restoredServer.authToken}`, ...options.headers },
      });
      assert(response.ok, `${resource}: ${response.status} ${await response.clone().text()}`);
      return response.json();
    };
    const inspection = await restoredRequest('/backups/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: await readFile(backupPath),
    });
    assert(inspection.stagedId);
    const result = await restoredRequest(`/backups/staged/${inspection.stagedId}/restore`, { method: 'POST' });
    assert.equal(result.restoredBooks, 3);
    const books = await restoredRequest('/books');
    assert.equal(books.books.length, 3);
    const restoredBookmarks = await restoredRequest(`/books/${textBookId}/bookmarks`);
    assert.equal(restoredBookmarks.bookmarks.length, 1);
    const restoredPdfAnnotations = await restoredRequest(`/books/${pdfBookId}/document-annotations`);
    assert.equal(restoredPdfAnnotations.annotations.length, 1);
    const restoredSource = await fetch(`${restoredServer.url}/api/books/${textBookId}/source`, {
      headers: { Authorization: `Bearer ${restoredServer.authToken}` },
    });
    assert.equal(restoredSource.status, 200);
    assert.deepEqual(
      Buffer.from(await restoredSource.arrayBuffer()),
      Buffer.from('1화 시작\n\n앱 창에서 내장 서버의 작품을 읽습니다.\n'),
    );
    evidence.nativeBackupRestored = true;
  } finally {
    await restoredServer?.stop();
  }
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
