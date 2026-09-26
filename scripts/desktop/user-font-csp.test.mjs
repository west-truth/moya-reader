import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

// Use an actual, already licensed PDF.js font, rather than a signature-only stub.
test('native CSP allows validating and reloading a user font', async () => {
  const require = createRequire(import.meta.url);
  const font = await readFile(require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'));
  const { app } = JSON.parse(await readFile(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [
      {
        name: 'font-csp-proof',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== '/__font-proof') return next();
            response.setHeader('Content-Type', 'text/html');
            response.setHeader('Content-Security-Policy', app.security.csp);
            response.end('<!doctype html><title>User font proof</title>');
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
    const violations = [];
    page.on('console', (message) => {
      if (message.text().includes('font-src')) violations.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__font-proof`);
    const result = await page.evaluate(
      async (bytes) => {
        const { prepareUserFont, verifyFontCanLoad } =
          await import('/src/features/reader-settings/user-font-service.ts');
        const { loadUserFont, unloadUserFont } = await import('/src/features/reader-settings/user-font-runtime.ts');
        const prepared = await prepareUserFont(new File([Uint8Array.from(bytes)], 'LiberationSans-Regular.ttf'));
        await verifyFontCanLoad(prepared.asset, prepared.blob);
        // Both a new selection and the later repository read go through the shipped loader.
        const repository = { getUserFontContent: async () => prepared.blob };
        const count = document.fonts.size;
        const family = await loadUserFont(repository, prepared.asset);
        const loaded = document.fonts.size === count + 1 && document.fonts.check(`16px ${family}`);
        unloadUserFont(prepared.asset.id);
        const removed = document.fonts.size === count;
        const reloaded = await loadUserFont(repository, prepared.asset);
        const restored = document.fonts.check(`16px ${reloaded}`) && document.fonts.size === count + 1;
        unloadUserFont(prepared.asset.id);
        return { loaded, removed, restored, sameFamily: reloaded === family };
      },
      [...font],
    );
    assert.deepEqual(result, { loaded: true, removed: true, restored: true, sameFamily: true });
    assert.deepEqual(violations, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
