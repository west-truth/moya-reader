import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { startEmbeddedServer } from './embedded-server.mjs';
import { sharingInterfaces, startSharing } from './embedded-sharing.mjs';

const runtimeFile = process.argv[2];
if (!runtimeFile) throw new Error('Pass a staged embedded runtime.json');
const profileDir = await mkdtemp(path.join(tmpdir(), 'Moya embedded 한글 '));
const result = { profileDir, platform: `${process.platform}-${process.arch}` };
let server;
let browser;
let sharing;
try {
  const start = Date.now();
  server = await startEmbeddedServer({ runtimeFile, profileDir });
  result.firstStartMs = Date.now() - start;
  await assert.rejects(startEmbeddedServer({ runtimeFile, profileDir }), /already open/);
  const url = server.url;
  const password = randomUUID();
  const request = async (resource, options = {}) => {
    const response = await fetch(`${server.url}/api${resource}`, {
      ...options,
      headers: { Authorization: `Bearer ${server.authToken}`, ...options.headers },
      signal: AbortSignal.timeout(10_000),
    });
    assert(response.ok, `${resource}: ${response.status} ${await response.clone().text()}`);
    return response.json();
  };
  const json = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await request('/auth/register', {
    method: 'POST',
    ...json({ username: 'desktop-test', password, setupCode: server.authToken }),
  });
  assert.equal((await fetch(`${url}/api/books`)).status, 401);
  assert.equal((await fetch(`${url}/`)).status, 200);
  const bytes = Buffer.from(
    '1화 시작\n\n모야 내장 서버의 독서 검증 문장입니다.\n\n재시작 뒤에도 이 작품을 읽습니다.\n',
    'utf8',
  );
  const upload = await request('/uploads/init', {
    method: 'POST',
    ...json({
      fileName: '내장 서버 검증.txt',
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
  const complete = await request(`/uploads/${upload.uploadId}/complete`, { method: 'POST' });
  let job;
  const deadline = Date.now() + 30_000;
  do {
    job = await request(`/import-jobs/${complete.jobId}`);
    assert.notEqual(job.status, 'failed', JSON.stringify(job));
    if (job.status !== 'done') await delay(100);
  } while (job.status !== 'done' && Date.now() < deadline);
  assert.equal(job.status, 'done');
  const bookId = job.book_id;
  assert(bookId);
  const chapters = await request(`/books/${bookId}/chapters`);
  const chapter = chapters.chapters[0];
  const pages = await request(`/chapters/${chapter.id}/pages?from=0&count=1`);
  const paragraph = pages.pages[0].paragraphs[0];
  const position = {
    chapterId: chapter.id,
    paragraphId: paragraph.id,
    paragraphIndex: paragraph.index,
    offsetInParagraph: 0,
    chapterProgress: 0.25,
    scrollTop: 120,
    deviceId: 'embedded-smoke',
    updatedAt: new Date().toISOString(),
  };
  assert.equal(
    (await request(`/books/${bookId}/reading-position`, { method: 'PATCH', ...json(position) })).applied,
    true,
  );
  const manifest = await request(`/books/${bookId}/manifest`);
  const source = await fetch(`${url}/api/books/${bookId}/source`, {
    headers: { Authorization: `Bearer ${server.authToken}` },
  });
  assert.equal(source.status, 200);
  assert.deepEqual(Buffer.from(await source.arrayBuffer()), bytes);
  await server.stop();
  server = undefined;
  const restart = Date.now();
  server = await startEmbeddedServer({ runtimeFile, profileDir });
  result.restartMs = Date.now() - restart;
  result.serverProcessResidentBytes =
    process.platform === 'win32'
      ? Number(
          execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              `(Get-Process -Id ${server.processIds.join(',')} | Measure-Object WorkingSet64 -Sum).Sum`,
            ],
            { encoding: 'utf8' },
          ).trim(),
        )
      : execFileSync('ps', ['-o', 'rss=', '-p', server.processIds.join(',')], { encoding: 'utf8' })
          .trim()
          .split(/\s+/)
          .reduce((sum, value) => sum + Number(value) * 1024, 0);
  assert.equal(server.url, url, 'browser origin must survive a restart');
  assert.deepEqual(await request(`/books/${bookId}/manifest`), manifest);
  result.bookId = bookId;
  result.apiAndPersistence = 'passed';

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const login = await context.request.post(`${url}/api/auth/login`, { data: { username: 'desktop-test', password } });
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  await page.goto(url);
  await page.getByText('내장 서버 검증', { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.locator('.book-continue-action').first().click();
  await page.getByText('모야 내장 서버의 독서 검증 문장입니다.', { exact: false }).first().waitFor({ timeout: 15_000 });
  await page.screenshot({ path: path.join(profileDir, 'reader.png') });
  result.authenticatedBrowserReader = 'passed';
  // A distinct browser session sees the same persisted server library.
  const peer = await browser.newContext();
  assert.equal((await peer.request.get(`${url}/api/books`)).status(), 401);
  assert.equal(
    (await peer.request.post(`${url}/api/auth/login`, { data: { username: 'desktop-test', password } })).status(),
    200,
  );
  assert.equal((await peer.request.get(`${url}/api/books/${bookId}/manifest`)).status(), 200);
  result.secondSession = 'passed';
  const network = sharingInterfaces()[0];
  if (network) {
    sharing = await startSharing({ url, host: network.address });
    const sharedUrl = sharing.url;
    const remote = await browser.newContext();
    assert.equal((await remote.request.get(`${sharedUrl}/api/books`)).status(), 401);
    assert.equal(
      (
        await remote.request.get(`${sharedUrl}/api/books`, {
          headers: { Authorization: `Bearer ${server.authToken}` },
        })
      ).status(),
      403,
    );
    assert.equal(
      (
        await remote.request.get(`${sharedUrl}/api/books`, {
          headers: { Origin: 'http://untrusted.invalid' },
        })
      ).status(),
      403,
    );
    assert.equal(
      (
        await remote.request.post(`${sharedUrl}/api/auth/login`, {
          data: { username: 'desktop-test', password },
        })
      ).status(),
      200,
    );
    const sharedPage = await remote.newPage();
    sharedPage.on('pageerror', (error) => console.error('Shared reader page error:', error.message));
    await sharedPage.goto(sharedUrl);
    await sharedPage
      .getByText('내장 서버 검증', { exact: true })
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(async (error) => {
        await sharedPage.screenshot({ path: path.join(profileDir, 'shared-reader-error.png') });
        throw error;
      });
    await sharedPage.locator('.book-continue-action').first().click();
    await sharedPage.getByText('모야 내장 서버의 독서 검증 문장입니다.', { exact: false }).first().waitFor();
    const changed = await remote.request.patch(`${sharedUrl}/api/books/${bookId}/reading-position`, {
      data: { ...position, chapterProgress: 0.75, updatedAt: new Date().toISOString(), deviceId: 'shared-browser' },
    });
    assert.equal(changed.status(), 200);
    const peerManifest = await remote.request.get(`${sharedUrl}/api/books/${bookId}/manifest`);
    assert.deepEqual(await peerManifest.json(), await request(`/books/${bookId}/manifest`));
    await sharing.stop();
    sharing = undefined;
    await assert.rejects(fetch(`${sharedUrl}/api/books`, { signal: AbortSignal.timeout(2000) }));
    assert.equal((await fetch(`${url}/api/ready`)).status, 200);
    result.privateNetworkSharing = 'authenticated reader, position update and revocation passed (same machine)';
  }
} finally {
  await sharing?.stop();
  await browser?.close();
  await server?.stop();
  await writeFile(path.join(profileDir, 'smoke-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
