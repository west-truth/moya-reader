import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordProfileGuard } from './embedded-inventory.mjs';

if (process.platform !== 'win32') throw new Error('Build the Windows installer on Windows');
const root = fileURLToPath(new URL('../../', import.meta.url));
const prerequisites = path.join(root, '.tmp/embedded-prerequisites');
await mkdir(prerequisites, { recursive: true });
const response = await fetch('https://aka.ms/vc14/vc_redist.x64.exe', { signal: AbortSignal.timeout(120_000) });
if (!response.ok || !new URL(response.url).hostname.endsWith('.microsoft.com'))
  throw new Error('Microsoft runtime download failed');
const bytes = Buffer.from(await response.arrayBuffer());
const installer = path.join(prerequisites, 'vc_redist.x64.exe');
await writeFile(installer, bytes);
const hooks = await readFile(path.join(root, 'src-tauri/installer/embedded-hooks.nsh'), 'utf8');
await writeFile(
  path.join(prerequisites, 'embedded-hooks.nsh'),
  hooks.replace('__MOYA_VC_REDIST__', () => installer.replaceAll('$', '$$')),
);
const verify = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "$s=Get-AuthenticodeSignature -LiteralPath $env:MOYA_VC_INSTALLER; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation'){exit 1}",
  ],
  { env: { ...process.env, MOYA_VC_INSTALLER: installer }, stdio: 'inherit' },
);
if (verify.status !== 0) throw new Error('Microsoft runtime signature verification failed');
await writeFile(
  path.join(prerequisites, 'inventory.json'),
  JSON.stringify(
    {
      url: response.url,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      signature: 'Valid Microsoft Corporation',
    },
    null,
    2,
  ),
);
const env = { ...process.env, MOYA_EMBEDDED_SERVER_BUILD: '1', VITE_DESKTOP_EMBEDDED_SERVER: 'true' };
const guard = spawnSync(
  'cargo',
  ['build', '--release', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'moya-server-guard'],
  { cwd: root, env, stdio: 'inherit' },
);
if (guard.status !== 0) throw new Error('Release profile guard build failed');
await cp(
  path.join(root, 'src-tauri/target/release/moya-server-guard.exe'),
  path.join(root, '.tmp/Moya app 한글/embedded-server/moya-server-guard.exe'),
);
await recordProfileGuard(path.join(root, '.tmp/Moya app 한글/embedded-server'));
const build = spawnSync(
  process.execPath,
  [
    'node_modules/@tauri-apps/cli/tauri.js',
    'build',
    '--ci',
    '--config',
    'src-tauri/tauri.embedded.installer.windows.conf.json',
  ],
  { cwd: root, env, stdio: 'inherit' },
);
if (build.error || build.status !== 0) throw new Error('Embedded installer build failed');
console.log('Installer candidate built. Clean-machine verification and redistribution audit remain release gates.');
