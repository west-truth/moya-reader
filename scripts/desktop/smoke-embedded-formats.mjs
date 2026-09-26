import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startEmbeddedServer } from './embedded-server.mjs';
import { epubFixture, pdfFixture } from './embedded-format-fixtures.mjs';

const profileDir = await mkdtemp(path.join(tmpdir(), 'Moya formats proof '));
const result = { formats: [], profileDir };
let server;
let browser;
try {
  server = await startEmbeddedServer({ runtimeFile: process.argv[2], profileDir });
  const request = async (resource, options = {}) => {
    const response = await fetch(`${server.url}/api${resource}`, {
      ...options,
      headers: { Authorization: `Bearer ${server.authToken}`, ...options.headers },
    });
    assert(response.ok, `${resource}: ${response.status} ${await response.clone().text()}`);
    return response.json();
  };
  const json = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const password = randomUUID();
  await request('/auth/register', {
    method: 'POST',
    ...json({ username: 'formats', password, setupCode: server.authToken }),
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  assert.equal(
    (await context.request.post(`${server.url}/api/auth/login`, { data: { username: 'formats', password } })).status(),
    200,
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(error.message));
  for (const [format, bytes, contentType, title] of [
    ['epub', await epubFixture(), 'application/epub+zip', 'Moya EPUB proof'],
    ['pdf', pdfFixture(), 'application/pdf', 'Moya PDF proof'],
  ]) {
    console.log(`Checking ${format} import and reader`);
    const upload = await request('/uploads/init', {
      method: 'POST',
      ...json({ fileName: `${title}.${format}`, sizeBytes: bytes.length, contentType, totalChunks: 1 }),
    });
    await request(`/uploads/${upload.uploadId}/chunks/0`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    const complete = await request(`/uploads/${upload.uploadId}/complete`, { method: 'POST' });
    let job;
    const deadline = Date.now() + 60_000;
    do {
      job = await request(`/import-jobs/${complete.jobId}`);
      assert.notEqual(job.status, 'failed', job.error_message);
      if (job.status !== 'done') await new Promise((resolve) => setTimeout(resolve, 250));
    } while (job.status !== 'done' && Date.now() < deadline);
    assert.equal(job.status, 'done');
    const source = await fetch(`${server.url}/api/books/${job.book_id}/source`, {
      headers: { Authorization: `Bearer ${server.authToken}` },
    });
    assert.equal(source.status, 200);
    assert.deepEqual(Buffer.from(await source.arrayBuffer()), bytes);
    await page.goto(server.url);
    await page
      .locator(`.book-continue-action[aria-label^="${title}"]`)
      .click()
      .catch(async (error) => {
        await page.screenshot({ path: path.join(profileDir, `${format}-error.png`) });
        console.error((await page.locator('body').innerText()).slice(0, 2000));
        throw error;
      });
    if (format === 'epub') await page.getByText('Embedded EPUB reading works.', { exact: false }).first().waitFor();
    else {
      await page
        .waitForFunction(() => {
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
        })
        .catch(async (error) => {
          await page.screenshot({ path: path.join(profileDir, 'pdf-error.png') });
          console.error((await page.locator('body').innerText()).slice(0, 2000));
          throw error;
        });
    }
    await page.screenshot({ path: path.join(profileDir, `${format}-reader.png`) });
    result.formats.push({ format, imported: true, originalPreserved: true, reader: true });
  }
  await writeFile(path.join(profileDir, 'formats-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await server?.stop();
}
