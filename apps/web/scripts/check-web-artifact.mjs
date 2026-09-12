import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('dist');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'offline-manifest.json'), 'utf8'));
assert(/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(manifest.base));
assert(manifest.files.includes(`${manifest.base}index.html`));
assert(manifest.files.some((file) => /import-worker.*\.js$/.test(file)));
assert(manifest.files.some((file) => file.endsWith('.wasm')));
assert(manifest.files.some((file) => file.includes('WebSyncPanel')));
assert(!manifest.files.some((file) => /(^|\/)(\.env|\.git|node_modules|apps|handoff)(\/|$)/.test(file)));
for (const file of manifest.files) {
  assert(file.startsWith(manifest.base));
  const full = path.resolve(root, file.slice(manifest.base.length));
  assert(full.startsWith(root + path.sep));
  assert(fs.statSync(full).isFile());
}
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert(!html.includes('runtime-config.js'), 'Offline boot must not depend on uncached server config');
assert(html.includes(`${manifest.base}assets/`));
assert(html.includes(`${manifest.base}manifest.webmanifest`));
for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  assert(url.startsWith(manifest.base), `HTML asset escaped deployment base: ${url}`);
}
const pwa = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
assert.equal(pwa.scope, './');
assert.equal(pwa.start_url, './');
assert(pwa.icons.every((icon) => !icon.src.startsWith('/')));
const worker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
assert(worker.includes(manifest.version));
assert(!worker.includes('__BUILD_VERSION__'));
assert(!worker.includes('caches.keys().then'), 'Use namespace-scoped cache cleanup');
console.log(
  `Static artifact verified: ${manifest.files.length} offline application assets, version ${manifest.version}`,
);
