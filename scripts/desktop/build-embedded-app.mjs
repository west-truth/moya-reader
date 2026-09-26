import { spawnSync } from 'node:child_process';
import { cp, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordProfileGuard } from './embedded-inventory.mjs';

if (process.platform !== 'win32') throw new Error('Build the Windows candidate on Windows');
const root = fileURLToPath(new URL('../../', import.meta.url));
const env = { ...process.env, MOYA_EMBEDDED_SERVER_BUILD: '1', VITE_DESKTOP_EMBEDDED_SERVER: 'true' };
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Embedded app build failed');
}
run(['node_modules/vite/bin/vite.js', 'build']);
const guardBuild = spawnSync(
  'cargo',
  ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'moya-server-guard'],
  { cwd: root, env, stdio: 'inherit' },
);
if (guardBuild.error || guardBuild.status !== 0) throw new Error('Profile guard build failed');
await cp(
  path.join(root, 'src-tauri/target/debug/moya-server-guard.exe'),
  path.join(root, '.tmp/embedded-windows/moya-server-guard.exe'),
);
await recordProfileGuard(path.join(root, '.tmp/embedded-windows'));
run([
  'node_modules/@tauri-apps/cli/tauri.js',
  'build',
  '--debug',
  '--no-bundle',
  '--ci',
  '--config',
  'src-tauri/tauri.embedded.windows.conf.json',
]);
const output = path.join(root, '.tmp', 'Moya app 한글');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(root, 'src-tauri/target/debug/noveldesk-reader.exe'), path.join(output, 'Moya.exe'));
// Relocate the entire payload; no original deployment directory may remain in use.
await rename(path.join(root, '.tmp/embedded-windows'), path.join(output, 'embedded-server'));
console.log(`Windows app verification folder: ${output}`);
