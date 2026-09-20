import { createRequire } from 'node:module';
import { basename, resolve } from 'node:path';
import { cp, mkdir, readFile, writeFile, chmod, rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { build } = require('esbuild');
const root = new URL('../../', import.meta.url);
const dist = new URL('./dist/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
// Preserve the runtime's separate QuickJS child process, WASM loading, and relative resource paths.
// Only generated package output; never touch extension installations or author projects.
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const bundle = await build({
  metafile: true,
  entryPoints: [fileURLToPath(new URL('scripts/extensions/cli.ts', root))],
  outfile: fileURLToPath(new URL('scripts/extensions/cli.js', dist)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: Object.keys(manifest.dependencies),
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as createBundleRequire } from "node:module"; const require = createBundleRequire(import.meta.url);',
  },
  plugins: [
    {
      name: 'retain-isolated-runtime',
      setup(builder) {
        builder.onResolve({ filter: /packages\/extension-runtime\/.*\.mjs$/ }, (args) => ({
          path: `../../packages/extension-runtime/${basename(args.path)}`,
          external: true,
        }));
      },
    },
  ],
});
// Host HTTP helpers include small CommonJS dependencies. Ship their license texts with the bundle.
const bundledPackages = new Set(
  Object.keys(bundle.metafile.inputs).flatMap((path) => {
    const matches = [...path.matchAll(/node_modules\/(?:@[^/]+\/)?[^/]+/g)];
    const match = matches.at(-1);
    return match ? [resolve(path.slice(0, match.index + match[0].length))] : [];
  }),
);
let notices = '';
for (const folder of [...bundledPackages].sort()) {
  const info = JSON.parse(await readFile(resolve(folder, 'package.json'), 'utf8'));
  const license = (await readdir(folder)).find((name) => /^licen[sc]e(?:\..*)?$/i.test(name));
  if (!license) throw new Error(`Missing bundled license: ${info.name}`);
  notices += `## ${info.name}@${info.version}\n\n${await readFile(resolve(folder, license), 'utf8')}\n\n`;
}
await writeFile(new URL('THIRD_PARTY_NOTICES.txt', dist), notices);
await chmod(new URL('scripts/extensions/cli.js', dist), 0o755);
const runtime = new URL('packages/extension-runtime/', root);
await mkdir(new URL('packages/extension-runtime/', dist), { recursive: true });
const runtimeManifest = JSON.parse(await readFile(new URL('package.json', runtime), 'utf8'));
for (const name of runtimeManifest.files) {
  if (name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    await cp(new URL(name, runtime), new URL(`packages/extension-runtime/${name}`, dist));
}
for (const name of ['text-catalog', 'image-catalog']) {
  const path = `packages/extension-runtime/examples/${name}/`;
  await mkdir(new URL(path + 'src/', dist), { recursive: true });
  for (const file of ['manifest.json', 'src/index.ts', 'content-input.json', 'fixtures.json', 'LICENSE'])
    await cp(new URL(path + file, root), new URL(path + file, dist));
}
await mkdir(new URL('packages/extension-contracts/', dist), { recursive: true });
await cp(
  new URL('packages/extension-contracts/source-sdk.ts', root),
  new URL('packages/extension-contracts/source-sdk.ts', dist),
);
await cp(new URL('LICENSE', root), new URL('LICENSE', dist));
// project.ts's build-tool resolver uses this inert anchor; no application files or credentials ship.
await mkdir(new URL('apps/server/', dist), { recursive: true });
await writeFile(new URL('apps/server/package.json', dist), '{"private":true,"type":"module"}\n');
console.log('Built standalone extension CLI.');
