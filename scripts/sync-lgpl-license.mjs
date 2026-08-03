import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SOURCE_URL = 'https://ftp.gnu.org/gnu/Licenses/lgpl-2.1.txt';
const EXPECTED_SHA256 = '20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95';
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const targetPath = path.join(repositoryRoot, 'third_party', 'licenses', 'common', 'LGPL-2.1.txt');
const checkOnly = process.argv.includes('--check');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function downloadOfficialLicense() {
  try {
    const response = await fetch(SOURCE_URL, {
      redirect: 'follow',
      headers: { 'user-agent': 'Moya-license-asset-sync/1.0' },
    });
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
  } catch {
    // Corporate Windows environments often expose their proxy only through WinHTTP/PowerShell.
  }
  if (process.platform === 'win32') {
    const command = [
      "$ProgressPreference = 'SilentlyContinue'",
      `$response = Invoke-WebRequest -UseBasicParsing '${SOURCE_URL}'`,
      '$bytes = [System.Text.Encoding]::UTF8.GetBytes($response.Content)',
      '[Console]::Out.Write([Convert]::ToBase64String($bytes))',
    ].join('; ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    if (result.status === 0 && result.stdout.trim())
      return Uint8Array.from(Buffer.from(result.stdout.trim(), 'base64'));
  }
  fail('GNU LGPL 2.1 download failed. Fetch the pinned official asset from the documented source and retry.');
}

if (checkOnly) {
  if (!existsSync(targetPath)) fail('Bundled GNU LGPL 2.1 text is missing. Run pnpm licenses:sync-lgpl.');
  const actual = sha256(readFileSync(targetPath));
  if (actual !== EXPECTED_SHA256) fail('Bundled GNU LGPL 2.1 text does not match the pinned official asset.');
  process.stdout.write('Bundled GNU LGPL 2.1 text verified.\n');
} else {
  const bytes = await downloadOfficialLicense();
  if (sha256(bytes) !== EXPECTED_SHA256) fail('Downloaded GNU LGPL 2.1 text does not match the pinned checksum.');
  writeFileSync(targetPath, bytes);
  process.stdout.write('Bundled the pinned official GNU LGPL 2.1 text.\n');
}
