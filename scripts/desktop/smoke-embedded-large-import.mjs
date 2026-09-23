import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ZipWriter, Uint8ArrayReader } from '@zip.js/zip.js';
import { chromium } from 'playwright-core';
import { startEmbeddedServer } from './embedded-server.mjs';

const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const sharp = require('sharp');
const profileDir = await mkdtemp(path.join(tmpdir(), 'Moya large archive proof '));
const filename = process.argv[3] ?? path.join(profileDir, '대용량 검증.cbz');
if (!process.argv[3]) {
  console.log('Creating a valid stored ZIP with 11 image pages (>500 MiB)');
  const png = await sharp(randomBytes(4096 * 4096 * 3), { raw: { width: 4096, height: 4096, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  const output = await open(filename, 'wx');
  const zip = new ZipWriter(
    new WritableStream({
      async write(chunk) {
        await output.writeFile(chunk);
      },
    }),
    { level: 0, useWebWorkers: false },
  );
  for (let i = 0; i < 11; i++) await zip.add(`${String(i + 1).padStart(3, '0')}.png`, new Uint8ArrayReader(png));
  await zip.close();
  await output.close();
}
const bytes = (await stat(filename)).size;
assert(bytes > 500 * 1024 ** 2);
let server;
let browser;
let sampler;
const result = { bytes, pages: 11, profileDir };
const start = Date.now();
try {
  server = await startEmbeddedServer({ runtimeFile: process.argv[2], profileDir });
  if (process.platform === 'linux') {
    result.resourceSampling =
      '2-second Linux samples; managed server PIDs only, excluding browser and PostgreSQL child processes';
    const sample = () => {
      const rss = execFileSync('ps', ['-o', 'rss=', '-p', server.processIds.join(',')], { encoding: 'utf8' })
        .trim()
        .split(/\s+/)
        .reduce((sum, value) => sum + Number(value) * 1024, 0);
      const disk = Number(execFileSync('du', ['-sb', profileDir], { encoding: 'utf8' }).split(/\s+/)[0]);
      result.peakSampledServerResidentBytes = Math.max(result.peakSampledServerResidentBytes ?? 0, rss);
      result.peakSampledProfileBytes = Math.max(result.peakSampledProfileBytes ?? 0, disk);
    };
    sample();
    result.initialProfileBytes = result.peakSampledProfileBytes;
    sampler = setInterval(sample, 2000);
  }
  const password = randomBytes(16).toString('hex');
  await fetch(`${server.url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'large-proof', password, setupCode: server.authToken }),
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  assert.equal(
    (
      await context.request.post(`${server.url}/api/auth/login`, { data: { username: 'large-proof', password } })
    ).status(),
    200,
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(error.message));
  await page.goto(server.url);
  await page.getByRole('button', { name: '책 가져오기', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles(filename);
  await page.getByRole('button', { name: '가져오기 시작', exact: true }).click({ timeout: 120_000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.task-progress-ring-value')].some(
        (node) => parseInt(node.textContent) > 0 && parseInt(node.textContent) < 100,
      ),
    undefined,
    { timeout: 120_000 },
  );
  result.numericProgress = true;
  await page.screenshot({ path: path.join(profileDir, 'numeric-progress.png') });
  // Background the active import; otherwise completion opens the series automatically.
  await page.getByRole('button', { name: '가져오기 닫기', exact: true }).click();
  // Follow the real server job created by the shared UI.
  const deadline = Date.now() + 600_000;
  let books;
  while (Date.now() < deadline) {
    assert.equal(
      await page.getByRole('heading', { name: '가져오기 실패', exact: true }).count(),
      0,
      'Import failed in shared UI',
    );
    books = await fetch(`${server.url}/api/books`, { headers: { Authorization: `Bearer ${server.authToken}` } }).then(
      (r) => r.json(),
    );
    if (books.books?.length) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(books.books?.length, 1, 'Large import did not commit');
  const bookId = books.books[0].id;
  result.importMs = Date.now() - start;
  await page.locator('.book-continue-action').first().click({ timeout: 30_000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.fixed-doc-pages img')].some((image) => image.complete && image.naturalWidth > 0),
    undefined,
    { timeout: 60_000 },
  );
  await page.screenshot({ path: path.join(profileDir, 'large-reader.png') });
  const expected = createHash('sha256');
  for await (const chunk of createReadStream(filename)) expected.update(chunk);
  const source = await fetch(`${server.url}/api/books/${bookId}/source`, {
    headers: { Authorization: `Bearer ${server.authToken}` },
  });
  assert.equal(source.status, 200);
  const actual = createHash('sha256');
  for await (const chunk of source.body) actual.update(chunk);
  assert.equal(actual.digest('hex'), expected.digest('hex'));
  result.originalPreserved = true;
  result.totalMs = Date.now() - start;
  await writeFile(path.join(profileDir, 'large-import-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  clearInterval(sampler);
  await browser?.close();
  await server?.stop();
}
