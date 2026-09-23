import { appendFile, copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Moya.exe must be built on Windows x64');
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const command = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const result = spawnSync(
  process.execPath,
  [command, 'build', '--no-bundle', '--ci', '--config', 'src-tauri/tauri.portable.windows.conf.json'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, MOYA_PORTABLE_BUILD: '1' },
  },
);
if (result.error || result.status !== 0) throw new Error('Portable Windows build failed');
const built = join(root, 'src-tauri', 'target', 'release', 'noveldesk-reader.exe');
if (!(await stat(built).catch(() => undefined))?.isFile()) throw new Error('Portable executable is missing');
const release = join(root, 'release');
await mkdir(release, { recursive: true });
const output = join(release, 'Moya.exe');
const stage = `${output}.${process.pid}.part`;
const cab = join(root, 'src-tauri', 'webview2-fixed.cab');
const cabSize = (await stat(cab)).size;
if (cabSize !== 308_509_880) throw new Error('The pinned WebView2 CAB has an unexpected size');
try {
  await copyFile(built, stage);
  const hash = createHash('sha256');
  await pipeline(
    createReadStream(cab),
    async function* (chunks) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(stage, { flags: 'a' }),
  );
  const digest = hash.digest();
  if (digest.toString('hex') !== '11e8240cb0bc56dcd3e4498907203c251346f65107fe35a3a13e152c7d51c79e')
    throw new Error('The pinned WebView2 CAB digest has changed');
  const footer = Buffer.alloc(56);
  footer.write('MOYA_WV2_CAB_V1!', 0, 'ascii');
  footer.writeBigUInt64LE(BigInt(cabSize), 16);
  digest.copy(footer, 24);
  await appendFile(stage, footer);
  await rename(stage, output);
} finally {
  await unlink(stage).catch(() => undefined);
}
console.log(`Portable executable: ${join(release, 'Moya.exe')}`);
