import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { chromium } from 'playwright-core';
import { startEmbeddedServer } from './embedded-server.mjs';

const profileDir = await mkdtemp(path.join(tmpdir(), 'Moya formats proof '));
const result = { formats: [], profileDir };
let server;
let browser;
function pdfFixture() {
  const text = 'BT /F1 24 Tf 72 720 Td (Moya PDF proof) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
async function epubFixture() {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const [name, value] of Object.entries({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
    'book.opf':
      '<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Moya EPUB proof</dc:title><dc:language>en</dc:language></metadata><manifest><item id="text" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="text"/></spine></package>',
    'chapter.xhtml':
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>First chapter</h1><p>Embedded EPUB reading works.</p></body></html>',
  }))
    await writer.add(name, new TextReader(value), { level: 0 });
  return Buffer.from(await (await writer.close()).arrayBuffer());
}
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
