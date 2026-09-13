import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { bundleApkRuntime } from './bundle-apk-runtime.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { build } = require('esbuild');
const output = resolve(root, 'src-tauri/extension-sidecar');
const version = '22.23.2';
const archiveName = `node-v${version}-win-x64.zip`;
// Official Node SHASUMS256.txt, checked 2026-09-12. Update together with native runtime gates.
const expected = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97';
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Native extension packaging currently supports Windows x64 only');
const cache = resolve(root, '.tmp', 'extension-node', archiveName);
await mkdir(dirname(cache), { recursive: true });
let archive = await readFile(cache).catch(() => undefined);
if (!archive || createHash('sha256').update(archive).digest('hex') !== expected) {
  const response = await fetch(`https://nodejs.org/dist/v${version}/${archiveName}`, {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error('Official Node download failed');
  archive = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== expected)
    throw new Error('Official Node archive digest mismatch');
  await writeFile(cache, archive);
}
// This is generated build output only, never app data or a user-selected path.
if (output !== resolve(root, 'src-tauri', 'extension-sidecar') || !output.startsWith(resolve(root) + sep))
  throw new Error('Invalid native build path');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await writeFile(join(output, '.gitkeep'), '');
const zip = new ZipReader(new BlobReader(new Blob([archive])), { useWebWorkers: false });
try {
  const entries = await zip.getEntries();
  for (const name of ['node.exe', 'LICENSE']) {
    const entry = entries.find((e) => e.filename === `node-v${version}-win-x64/${name}`);
    if (!entry?.getData) throw new Error('Official Node distribution is incomplete');
    await writeFile(
      join(output, name === 'LICENSE' ? 'NODE-LICENSE' : name),
      await entry.getData(new Uint8ArrayWriter()),
    );
  }
} finally {
  await zip.close();
}
await build({
  absWorkingDir: root,
  entryPoints: ['scripts/extensions/native-entry.ts'],
  outfile: join(output, 'native-entry.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: [
    '@moya/extension-runtime',
    '@moya/extension-runtime/source-broker',
    'https-proxy-agent',
    'agent-base',
    'socks',
    'playwright-core',
    'patchright',
    'tough-cookie',
  ],
  alias: {
    '@noveldesk/extension-contracts/source-protocol': join(root, 'packages/extension-contracts/source-protocol.ts'),
    '@noveldesk/extension-contracts/package': join(root, 'packages/extension-contracts/package-manifest.ts'),
    '@noveldesk/extension-contracts': join(root, 'packages/extension-contracts/index.ts'),
  },
  legalComments: 'inline',
});
const copied = new Set();
async function copyPackage(name, from) {
  if (copied.has(name)) return;
  copied.add(name);
  const resolver = createRequire(join(from, 'package.json'));
  let folder =
    name === '@moya/extension-runtime' ? join(root, 'packages/extension-runtime') : dirname(resolver.resolve(name));
  while (JSON.parse(await readFile(join(folder, 'package.json'), 'utf8').catch(() => '{}')).name !== name) {
    const parent = dirname(folder);
    if (parent === folder) throw new Error(`Cannot resolve ${name}`);
    folder = parent;
  }
  const manifest = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
  const target = join(output, 'node_modules', name);
  await mkdir(target, { recursive: true });
  if (name === '@moya/extension-runtime')
    for (const file of ['package.json', ...manifest.files]) {
      // The standalone runtime ships the contract constants, not a workspace-relative re-export.
      const sourceFolder = file.startsWith('content-limits.') ? join(root, 'packages/extension-contracts') : folder;
      await cp(join(sourceFolder, file), join(target, file));
    }
  else
    await cp(folder, target, {
      recursive: true,
      dereference: true,
      filter: (file) => !relative(folder, file).split(sep).includes('node_modules'),
    });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) await copyPackage(dependency, folder);
}
await copyPackage('@moya/extension-runtime', root);
await copyPackage('linkedom', join(root, 'apps/server'));
await copyPackage('https-proxy-agent', join(root, 'apps/server'));
await copyPackage('agent-base', join(root, 'apps/server'));
await copyPackage('socks', join(root, 'apps/server'));
await copyPackage('playwright-core', join(root, 'apps/server'));
await copyPackage('patchright', join(root, 'apps/server'));
await copyPackage('tough-cookie', join(root, 'apps/server'));
await cp(join(root, 'third_party/licenses/mangayomi-dom'), join(output, 'licenses/mangayomi-dom'), { recursive: true });
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(join(root, file), join(output, file));
await cp(join(root, 'node_modules/@zip.js/zip.js/LICENSE'), join(output, 'ZIP-LICENSE'));
await writeFile(
  join(output, 'runtime-version.json'),
  JSON.stringify(
    { node: version, archive: archiveName, sha256: expected, platform: 'win32-x64', packages: [...copied] },
    null,
    2,
  ) + '\n',
);
await bundleApkRuntime(root, join(output, 'apk-runtime'));
console.log(`Native extension runtime packaged: ${output}`);
