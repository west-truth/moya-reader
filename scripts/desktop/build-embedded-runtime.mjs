import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this payload on Windows x64');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, '.tmp', 'embedded-windows');
const cache = path.join(root, '.tmp', 'embedded-downloads');
const deploy = path.join(output, 'server');
const components = [
  {
    name: 'cloudflared',
    url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.9.1/cloudflared-windows-amd64.exe',
    sha256: '2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712',
    binary: 'cloudflared.exe',
  },
  {
    name: 'node',
    url: 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip',
    sha256: '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97',
    prefix: 'node-v22.23.2-win-x64/',
    include: (name) => ['node.exe', 'LICENSE'].includes(name),
  },
  {
    name: 'postgres',
    url: 'https://get.enterprisedb.com/postgresql/postgresql-16.15-1-windows-x64-binaries.zip',
    sha256: '25e6fcdfb8caec38691bf461125e7564508760666f7b8e5dc6a5f0818f58f81e',
    prefix: 'pgsql/',
    include: (name) =>
      /^(bin|lib|share)\//.test(name) ||
      ['server_license.txt', 'commandlinetools_3rd_party_licenses.txt'].includes(name),
  },
  {
    name: 'redis',
    url: 'https://github.com/redis-windows/redis-windows/releases/download/7.2.16/Redis-7.2.16-Windows-x64-cygwin.zip',
    sha256: 'ccbb1d2fdbdc339c26cb369723b54c2fe23291136e8d9ca293345960742e864c',
    prefix: 'Redis-7.2.16-Windows-x64-cygwin/',
    include: (name) =>
      name.endsWith('.dll') ||
      /^(redis-server|redis-cli|redis-check-aof|redis-check-rdb)\.exe$/.test(name) ||
      name === 'README.md',
  },
];

function run(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Build command failed (${result.status})`);
}

// All removed paths are fixed build outputs, never runtime profiles.
await rm(output, { recursive: true, force: true });
await rm(deploy, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(cache, { recursive: true });
const inventory = [];
for (const component of components) {
  const archivePath = path.join(cache, `${component.name}-${component.sha256}.${component.binary ? 'bin' : 'zip'}`);
  let archive = await readFile(archivePath).catch(() => undefined);
  const valid = (bytes) => bytes && createHash('sha256').update(bytes).digest('hex') === component.sha256;
  if (!valid(archive)) {
    const response = await fetch(component.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Download failed: ${component.name}`);
    archive = Buffer.from(await response.arrayBuffer());
    if (!valid(archive)) throw new Error(`Runtime digest mismatch: ${component.name}`);
    await writeFile(archivePath, archive);
  }
  let installedBytes = 0;
  if (component.binary) {
    await mkdir(path.join(output, component.name), { recursive: true });
    await writeFile(path.join(output, component.name, component.binary), archive);
    installedBytes = archive.byteLength;
  } else {
    const zip = new ZipReader(new BlobReader(new Blob([archive])), { useWebWorkers: false });
    try {
      for (const entry of await zip.getEntries()) {
        if (entry.directory || !entry.filename.startsWith(component.prefix)) continue;
        const name = entry.filename.slice(component.prefix.length);
        if (!component.include(name)) continue;
        if (name.includes('\\') || name.split('/').some((part) => part === '..' || part === '.'))
          throw new Error('Invalid runtime entry');
        const target = path.join(output, component.name, name);
        await mkdir(path.dirname(target), { recursive: true });
        const bytes = await entry.getData(new Uint8ArrayWriter());
        await writeFile(target, bytes);
        installedBytes += bytes.byteLength;
      }
    } finally {
      await zip.close();
    }
  }
  inventory.push({
    name: component.name,
    url: component.url,
    sha256: component.sha256,
    archiveBytes: archive.byteLength,
    installedBytes,
  });
}

// PostgreSQL's narrow Windows argv/getcwd must agree on UTF-8. Relative paths
// alone do not fix its bootstrap subprocess. Preserve the vendor trust manifest
// and add the documented per-process code page, without changing the system locale.
const sdkBin = path.join(process.env['ProgramFiles(x86)'], 'Windows Kits', '10', 'bin');
const sdkVersions = (await readdir(sdkBin))
  .filter((name) => /^10\./.test(name))
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
const mt = path.join(sdkBin, sdkVersions[0], 'x64', 'mt.exe');
const utf8Manifest = path.join(output, 'postgres', 'moya-utf8.manifest');
await writeFile(
  utf8Manifest,
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings>
    <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
  </windowsSettings></application>
</assembly>
`,
);
const modifiedExecutables = [];
for (const name of (await readdir(path.join(output, 'postgres/bin'))).filter((name) => name.endsWith('.exe'))) {
  const executable = path.join(output, 'postgres/bin', name);
  run(mt, [
    '-nologo',
    `-inputresource:${executable};#1`,
    '-manifest',
    utf8Manifest,
    `-outputresource:${executable};#1`,
  ]);
  modifiedExecutables.push({
    name,
    sha256: createHash('sha256')
      .update(await readFile(executable))
      .digest('hex'),
  });
}
await writeFile(
  path.join(output, 'postgres', 'manifest-adjustments.json'),
  JSON.stringify(
    {
      reason: 'Use UTF-8 Windows paths on Windows 10 1903 or newer',
      recipe: 'scripts/desktop/build-embedded-runtime.mjs',
      modifiedExecutables,
    },
    null,
    2,
  ),
);

run(process.execPath, [path.join(root, 'apps/server/build.mjs')]);
// Reuse the same production dependency deployment as deploy/server.Dockerfile.
const corepack = path.join(path.dirname(process.execPath), 'node_modules/corepack/dist/pnpm.js');
run(process.execPath, [
  corepack,
  '--config.inject-workspace-packages=true',
  '--config.node-linker=hoisted',
  '--filter',
  'server',
  'deploy',
  '--prod',
  deploy,
]);
await mkdir(path.join(output, 'server'), { recursive: true });
// Hoisted deployment uses physical dependency folders and remains valid after installation or a folder move.
await rm(path.join(deploy, 'src'), { recursive: true, force: true });
await cp(path.join(root, 'apps/server/dist'), path.join(output, 'server/dist'), { recursive: true });
await cp(path.join(root, 'apps/server/package.json'), path.join(output, 'server/package.json'));
run(
  process.execPath,
  [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', path.join(output, 'web')],
  {
    ...process.env,
    VITE_READER_BACKEND: 'remote',
    VITE_API_BASE_URL: '/api',
  },
);
for (const script of ['embedded-server.mjs', 'embedded-sharing.mjs', 'embedded-tunnel.mjs', 'embedded-recovery.mjs']) {
  await cp(path.join(root, 'scripts/desktop', script), path.join(output, script));
}
await cp(path.join(root, 'third_party/licenses/cloudflared/LICENSE'), path.join(output, 'cloudflared/LICENSE'));
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(path.join(root, name), path.join(output, name));
await writeFile(
  path.join(output, 'runtime.json'),
  JSON.stringify(
    {
      version: 1,
      platform: 'win32-x64',
      postgresMajor: 16,
      cloudflared: 'cloudflared/cloudflared.exe',
      node: 'node/node.exe',
      profileGuard: 'moya-server-guard.exe',
      postgresBin: 'postgres/bin',
      redisServer: 'redis/redis-server.exe',
      redisCli: 'redis/redis-cli.exe',
      serverDir: 'server',
      webDir: 'web',
    },
    null,
    2,
  ),
);
async function directoryBytes(folder) {
  let bytes = 0;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(file);
    else if (entry.isFile()) bytes += (await stat(file)).size;
  }
  return bytes;
}
for (const name of ['server', 'web'])
  inventory.push({ name, installedBytes: await directoryBytes(path.join(output, name)) });
await writeFile(
  path.join(output, 'inventory.json'),
  JSON.stringify(
    {
      status: 'Embedded runtime verification payload; not a desktop release',
      redistributionGate: 'Complete third-party source/notices inventory, including Redis and Cygwin, before release',
      components: inventory,
      totalInstalledBytes: await directoryBytes(output),
    },
    null,
    2,
  ),
);
console.log(`Embedded server verification payload: ${output}`);
