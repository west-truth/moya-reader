import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const root = path.resolve('dist');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'offline-manifest.json'), 'utf8'));
assert(/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(manifest.base));
assert(manifest.files.includes(`${manifest.base}index.html`));
assert(manifest.files.some((file) => /import-worker.*\.js$/.test(file)));
assert(manifest.files.some((file) => file.endsWith('.wasm')));
assert(manifest.files.some((file) => file.includes('WebSyncPanel')));
assert(manifest.precache.includes(`${manifest.base}index.html`));
assert(manifest.precache.every((file) => manifest.files.includes(file)));
assert(
  !manifest.precache.some((file) => file.endsWith('.wasm') || /pdf\.worker/.test(file)),
  'Optional engines must not delay first installation',
);
assert(manifest.precache.length < manifest.files.length);
assert(!manifest.files.some((file) => /(^|\/)(\.env|\.git|node_modules|apps|handoff)(\/|$)/.test(file)));
for (const file of manifest.files) {
  assert(file.startsWith(manifest.base));
  const full = path.resolve(root, file.slice(manifest.base.length));
  assert(full.startsWith(root + path.sep));
  assert(fs.statSync(full).isFile());
  const asset = manifest.assets.find((asset) => asset.url === file);
  const bytes = fs.readFileSync(full);
  assert.equal(asset.bytes, bytes.length);
  assert.equal(asset.integrity, 'sha256-' + createHash('sha256').update(bytes).digest('base64'));
}
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const coreBytes = manifest.assets
  .filter((asset) => manifest.precache.includes(asset.url))
  .reduce((sum, asset) => sum + asset.bytes, 0);
assert(coreBytes <= 4 * 1024 * 1024, `Initial offline assets exceed 4MiB: ${coreBytes}`);
const entry = html.match(/<script[^>]+src="([^"]+)"/)[1];
assert(manifest.precache.includes(entry));
const entryGzip = gzipSync(fs.readFileSync(path.join(root, entry.slice(manifest.base.length)))).length;
assert(entryGzip <= 650 * 1024, `Entry JS exceeds 650KiB gzip: ${entryGzip}`);
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
  `Static artifact verified: ${manifest.precache.length} initial assets / ${coreBytes} bytes; ${manifest.files.length} full offline assets; entry gzip ${entryGzip} bytes; version ${manifest.version}`,
);
