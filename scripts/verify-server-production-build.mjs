#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));
const serverRoot = path.join(workspaceRoot, 'apps/server');
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`[ok] ${label}`);
    return;
  }
  failures.push(detail ? `${label}: ${detail}` : label);
  console.error(`[fail] ${label}${detail ? `: ${detail}` : ''}`);
}

async function read(relativePath) {
  return readFile(path.join(workspaceRoot, relativePath), 'utf8');
}

async function migrationFiles(relativeDirectory) {
  return (await readdir(path.join(workspaceRoot, relativeDirectory), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
}

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function serviceBlock(compose, name) {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return '';
  const block = [];
  for (const line of lines.slice(start)) {
    if (block.length > 0 && /^ {2}\S/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

function packageName(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('node:')) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const [packageText, buildSource, tsconfigSource, dockerfile, dockerignore, compose, sourceSchema, migrationSource] =
  await Promise.all([
    read('apps/server/package.json'),
    read('apps/server/build.mjs'),
    read('apps/server/tsconfig.json'),
    read('deploy/server.Dockerfile'),
    read('.dockerignore'),
    read('compose.yaml'),
    read('apps/server/src/db/schema.sql'),
    read('apps/server/src/db/migrate.ts'),
  ]);
const serverPackage = JSON.parse(packageText);
const serverTsconfig = JSON.parse(tsconfigSource);

check('server build remains typecheck-only', serverPackage.scripts.build === 'tsc -p tsconfig.json --noEmit');
check('esbuild is a direct dev dependency', Boolean(serverPackage.devDependencies?.esbuild));
check(
  'text-core is a direct server workspace dependency',
  serverPackage.devDependencies?.['@noveldesk/text-core'] === 'workspace:*' ||
    serverPackage.dependencies?.['@noveldesk/text-core'] === 'workspace:*',
);
check('tsx is development-only', Boolean(serverPackage.devDependencies?.tsx) && !serverPackage.dependencies?.tsx);
check(
  'server TypeScript excludes root domain runtime sources',
  !(serverTsconfig.include ?? []).some((entry) => entry.includes('src/domain')),
);
for (const subpath of [
  'hash',
  'legacy-hash',
  'normalization',
  'parser',
  'chapter-structure',
  'image-format',
  'library-metadata',
  'identity/parser',
  'identity/reader',
  'identity/ai',
  'identity/provider',
  'identity/sync',
  'identity/tts',
  'identity/workflow',
]) {
  check(`esbuild aliases text-core/${subpath}`, buildSource.includes(`'@noveldesk/text-core/${subpath}'`));
}
check('production API script uses Node', serverPackage.scripts['start:production'] === 'node dist/index.js');
check('production worker script uses Node', serverPackage.scripts['worker:production'] === 'node dist/worker.js');
check(
  'production ID v2 migration script uses Node',
  serverPackage.scripts['id-v2:migrate:production'] === 'node dist/cli/id-v2-migration.js',
);

const sourceMigrationFiles = await migrationFiles('apps/server/src/db/migrations');
const bundledMigrationFiles = await migrationFiles('apps/server/dist/db/migrations').catch(() => []);
const artifacts = [
  'dist/index.js',
  'dist/worker.js',
  'dist/db/migrate.js',
  'dist/cli/id-v2-migration.js',
  'dist/db/schema.sql',
  ...sourceMigrationFiles.map((fileName) => `dist/db/migrations/${fileName}`),
];
for (const artifact of artifacts) {
  try {
    await access(path.join(serverRoot, artifact));
    check(`artifact exists: ${artifact}`, true);
  } catch {
    check(`artifact exists: ${artifact}`, false);
  }
}

for (const artifact of artifacts.filter((entry) => entry.endsWith('.js'))) {
  const absolutePath = path.join(serverRoot, artifact);
  const result = spawnSync(process.execPath, ['--check', absolutePath], { encoding: 'utf8' });
  check(`Node syntax check: ${artifact}`, result.status === 0, (result.stderr || result.stdout).trim());
}

try {
  const migrationModule = await import(
    `${pathToFileURL(path.join(serverRoot, 'dist/db/migrate.js')).href}?smoke=${Date.now()}`
  );
  check('migration artifact is import-safe', typeof migrationModule.runMigrations === 'function');
} catch (error) {
  check('migration artifact is import-safe', false, error instanceof Error ? error.message : String(error));
}

const bundledSchema = await read('apps/server/dist/db/schema.sql').catch(() => '');
check('consolidated schema snapshot is copied without changes', bundledSchema === sourceSchema);
check(
  'runtime migration assets are numbered SQL files',
  sourceMigrationFiles.length > 0 &&
    sourceMigrationFiles.every((fileName, index) => fileName.startsWith(`${String(index + 1).padStart(4, '0')}_`)),
);
check(
  'runtime migration file set is copied exactly',
  JSON.stringify(bundledMigrationFiles) === JSON.stringify(sourceMigrationFiles),
);
for (const fileName of sourceMigrationFiles) {
  const source = await read(`apps/server/src/db/migrations/${fileName}`);
  const bundled = await read(`apps/server/dist/db/migrations/${fileName}`).catch(() => '');
  check(`migration is copied exactly: ${fileName}`, bundled === source);
  check(`migration checksum is preserved: ${fileName}`, sha256(bundled) === sha256(source));
}
check(
  'migration runner loads the numbered directory instead of schema snapshot',
  migrationSource.includes("new URL('./migrations/', import.meta.url)") && !migrationSource.includes("'schema.sql'"),
);

const indexBundle = await read('apps/server/dist/index.js').catch(() => '');
check(
  'API bundle delegates migration to its dedicated artifact',
  /from\s+["']\.\/db\/migrate\.js["']/.test(indexBundle) &&
    !indexBundle.includes('import.meta.url === pathToFileURL(process.argv[1])'),
);

const productionDependencies = new Set(Object.keys(serverPackage.dependencies ?? {}));
const externalPackages = new Set();
const runtimeArtifacts = [];
for (const artifact of artifacts.filter((entry) => entry.endsWith('.js'))) {
  const source = await read(`apps/server/${artifact}`).catch(() => '');
  runtimeArtifacts.push([artifact, source]);
  for (const match of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)["']([^"'\s]+)["']/g)) {
    const name = packageName(match[1]);
    if (name) externalPackages.add(name);
  }
}
check(
  'shared contracts are absent from production runtime imports',
  runtimeArtifacts.every(([, source]) => !source.includes('@noveldesk/contracts')),
);
check(
  'text-core is bundled into production artifacts',
  runtimeArtifacts.some(([, source]) => source.includes('packages/text-core/')) &&
    runtimeArtifacts.every(([, source]) => source.length > 0 && !source.includes('@noveldesk/text-core')),
);
check(
  'production artifacts do not reference root domain runtime sources',
  runtimeArtifacts.every(([, source]) => source.length > 0 && !source.includes('src/domain/')),
);
check('bundle keeps npm packages external', externalPackages.size > 0);
for (const dependency of externalPackages) {
  check(`external is a production dependency: ${dependency}`, productionDependencies.has(dependency));
}

check('Dockerfile has a Debian Bookworm Node 22 build stage', /FROM node:22-bookworm-slim AS build/i.test(dockerfile));
check(
  'Docker build installs and copies shared workspaces',
  dockerfile.includes('COPY packages/contracts/package.json packages/contracts/package.json') &&
    dockerfile.includes('COPY packages/contracts packages/contracts') &&
    dockerfile.includes('COPY packages/extension-contracts/package.json packages/extension-contracts/package.json') &&
    dockerfile.includes('COPY packages/extension-contracts packages/extension-contracts') &&
    dockerfile.includes('COPY packages/epub-core/package.json packages/epub-core/package.json') &&
    dockerfile.includes('COPY packages/epub-core packages/epub-core') &&
    dockerfile.includes('COPY packages/fixed-document-core/package.json packages/fixed-document-core/package.json') &&
    dockerfile.includes('COPY packages/fixed-document-core packages/fixed-document-core') &&
    dockerfile.includes('COPY packages/text-core/package.json packages/text-core/package.json') &&
    dockerfile.includes('COPY packages/text-core packages/text-core'),
);
check('Dockerfile creates a production dependency stage', /FROM build AS production-dependencies/i.test(dockerfile));
check('Dockerfile generates the server bundle', dockerfile.includes('pnpm --filter server bundle'));
check('Dockerfile deploys production dependencies only', dockerfile.includes('deploy --prod /opt/server'));

const runtimeMarker = 'FROM node:22-bookworm-slim AS runtime';
const runtimeIndex = dockerfile.indexOf(runtimeMarker);
const runtimeStage = runtimeIndex >= 0 ? dockerfile.slice(runtimeIndex) : '';
check('Dockerfile has a Debian Bookworm Node 22 runtime stage', runtimeIndex >= 0);
check(
  'runtime copies only deployed node_modules and dist',
  runtimeStage.includes('/opt/server/node_modules') && runtimeStage.includes('/workspace/apps/server/dist'),
);
check(
  'runtime excludes source and package-manager commands',
  !/(?:COPY[^\n]*\bsrc\b|\bpnpm\b|\btsx\b|\bcorepack\b)/i.test(runtimeStage),
);
check('runtime runs as the node user', runtimeStage.includes('USER node'));
check('runtime starts compiled JavaScript', runtimeStage.includes('CMD ["node", "dist/index.js"]'));

const api = serviceBlock(compose, 'api');
const worker = serviceBlock(compose, 'worker');
check('Compose API runs the compiled entry', /command:\s*\[['"]node['"],\s*['"]dist\/index\.js['"]\]/.test(api));
check('Compose worker runs the compiled entry', /command:\s*\[['"]node['"],\s*['"]dist\/worker\.js['"]\]/.test(worker));

const ignoredPatterns = new Set(dockerignore.split(/\r?\n/).map((line) => line.trim()));
for (const ignored of [
  'vertex env/',
  '.server-test-data/',
  'test_novel/',
  'smart-novel-reader-codex-pack/',
  'ui-reference/',
  'fixtures/generated/',
  'src-tauri/',
]) {
  check(`Docker context excludes ${ignored}`, ignoredPatterns.has(ignored));
}

if (failures.length > 0) {
  console.error(`\nServer production build verification failed (${failures.length}).`);
  process.exit(1);
}

console.log('\nServer production build verification passed.');
