import { createRequire } from 'node:module';
import { cp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
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
await build({
  entryPoints: [fileURLToPath(new URL('scripts/extensions/cli.ts', root))],
  outfile: fileURLToPath(new URL('scripts/extensions/cli.js', dist)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: Object.keys(manifest.dependencies),
  banner: { js: '#!/usr/bin/env node' },
  plugins: [
    {
      name: 'retain-isolated-runtime',
      setup(builder) {
        builder.onResolve({ filter: /packages\/extension-runtime\/.*\.mjs$/ }, (args) => ({
          path: args.path,
          external: true,
        }));
      },
    },
  ],
});
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
