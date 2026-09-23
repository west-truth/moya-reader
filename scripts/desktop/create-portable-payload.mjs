import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ZipWriter } from '@zip.js/zip.js';

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Portable payloads can only be built on Windows x64');

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tauri = join(root, 'src-tauri');
const output = join(tauri, 'portable-payload.zip');
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
  await writer.close();
} catch (error) {
  stream.destroy();
  throw error;
}
console.log(`Portable payload created: ${output}`);
