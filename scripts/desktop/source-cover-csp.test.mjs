import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

// Exercise the actual source-cover persistence function under the shipped native CSP.
// The catalog can display blob images even when fetch(blob:) is forbidden.
test('native CSP permits persisting a downloaded source cover', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const { app } = JSON.parse(await readFile(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const server = await createServer({
    root,
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [
      {
        name: 'cover-proof',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== '/__cover-proof') return next();
            response.setHeader('Content-Type', 'text/html');
            response.setHeader('Content-Security-Policy', app.security.csp);
            response.end('<!doctype html><title>Cover persistence proof</title>');
          });
        },
      },
    ],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__cover-proof`);
    const result = await page.evaluate(async () => {
      const { persistSourceCover } = await import('/src/features/external-sources/source-cover.ts');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      canvas.getContext('2d').fillRect(0, 0, 1, 1);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const url = URL.createObjectURL(blob);
      let saved;
      try {
        const changed = await persistSourceCover(
          {
            getActiveCover: async () => undefined,
            saveApprovedEnrichmentCover: async (id, input) => {
              saved = {
                id,
                type: input.blob.type,
                bytesMatch: input.blob.size === blob.size,
                width: input.pixelWidth,
                revision: input.expectedMetadataRevision,
              };
            },
          },
          { id: 'downloaded-book', title: '표지', metadataRevision: 3 },
          url,
        );
        return { changed, saved };
      } finally {
        URL.revokeObjectURL(url);
      }
    });
    assert.deepEqual(result, {
      changed: true,
      saved: { id: 'downloaded-book', type: 'image/png', bytesMatch: true, width: 1, revision: 3 },
    });
  } finally {
    await browser?.close();
    await server.close();
  }
});
