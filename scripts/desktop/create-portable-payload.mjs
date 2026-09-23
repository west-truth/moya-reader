import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, rename, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { ZipWriter } from '@zip.js/zip.js';

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Portable payloads can only be built on Windows x64');

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tauri = join(root, 'src-tauri');
const output = join(tauri, 'portable-payload.zip');
const webviewCab = join(tauri, 'webview2-fixed.cab');
const webviewUrl =
  'https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/08cd33ee-d109-49b8-9301-9f0bea43c575/Microsoft.WebView2.FixedVersionRuntime.153.0.4234.48.x64.cab';
const webviewSha256 = '11e8240cb0bc56dcd3e4498907203c251346f65107fe35a3a13e152c7d51c79e';

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

if ((await stat(webviewCab).catch(() => undefined))?.isFile() && (await sha256(webviewCab)) !== webviewSha256)
  throw new Error('Cached Microsoft WebView2 runtime digest does not match the pinned release');
if (!(await stat(webviewCab).catch(() => undefined))?.isFile()) {
  const response = await fetch(webviewUrl);
  if (!response.ok || !response.body) throw new Error(`Microsoft WebView2 runtime download failed: ${response.status}`);
  const stage = webviewCab + `.${process.pid}.part`;
  const hash = createHash('sha256');
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(stage, { flags: 'wx' }),
    );
    if (hash.digest('hex') !== webviewSha256) throw new Error('Microsoft WebView2 runtime digest mismatch');
    await rename(stage, webviewCab);
  } finally {
    await unlink(stage).catch(() => undefined);
  }
}
const entries = [
  ['extension-sidecar', 'node.exe'],
  ['extension-sidecar', 'native-entry.mjs'],
  ['collector-sidecar', 'webnovel-metadata-collector.exe'],
];
for (const parts of entries) {
  if (!(await stat(join(tauri, ...parts)).catch(() => undefined))?.isFile())
    throw new Error(`Portable runtime file is missing: ${parts.join('/')}`);
}

async function* files(folder) {
  for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
    else throw new Error(`Unsupported portable runtime entry: ${path}`);
  }
}

const stream = createWriteStream(output);
const writer = new ZipWriter(Writable.toWeb(stream), { useWebWorkers: false });
try {
  for (const directory of ['extension-sidecar', 'collector-sidecar']) {
    for await (const file of files(join(tauri, directory))) {
      const name = relative(tauri, file).split(sep).join('/');
      await writer.add(name, Readable.toWeb(createReadStream(file)), {
        level: 6,
        lastModDate: new Date('2020-01-01T00:00:00Z'),
      });
    }
  }
  await writer.add('webview2-fixed.cab', Readable.toWeb(createReadStream(webviewCab)), {
    level: 0,
    lastModDate: new Date('2020-01-01T00:00:00Z'),
  });
  await writer.close();
} catch (error) {
  stream.destroy();
  throw error;
}
console.log(`Portable payload created: ${output}`);
