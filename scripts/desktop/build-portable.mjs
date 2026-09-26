import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
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
try {
  await copyFile(built, stage);
  await rename(stage, output);
} finally {
  await unlink(stage).catch(() => undefined);
}
console.log(`Portable executable: ${join(release, 'Moya.exe')}`);
