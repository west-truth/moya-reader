import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(serverRoot, 'dist');

await rm(outdir, { force: true, recursive: true });

await build({
  absWorkingDir: serverRoot,
  alias: {
    '@noveldesk/contracts/sync': '../../packages/contracts/sync.ts',
    '@noveldesk/contracts': '../../packages/contracts/index.ts',
    '@noveldesk/document-series-core': '../../packages/document-series-core/index.ts',
    '@noveldesk/epub-core': '../../packages/epub-core/index.ts',
    '@noveldesk/fixed-document-core/comic-source': '../../packages/fixed-document-core/comic-source.ts',
    '@noveldesk/fixed-document-core/series-image-archive': '../../packages/fixed-document-core/series-image-archive.ts',
    '@noveldesk/fixed-document-core': '../../packages/fixed-document-core/index.ts',
    '@noveldesk/text-core/hash': '../../packages/text-core/hash.ts',
    '@noveldesk/text-core/legacy-hash': '../../packages/text-core/legacy-hash.ts',
    '@noveldesk/text-core/normalization': '../../packages/text-core/normalization.ts',
    '@noveldesk/text-core/parser': '../../packages/text-core/parser.ts',
    '@noveldesk/text-core/chapter-structure': '../../packages/text-core/chapter-structure.ts',
    '@noveldesk/text-core/image-format': '../../packages/text-core/image-format.ts',
    '@noveldesk/text-core/library-metadata': '../../packages/text-core/library-metadata.ts',
    '@noveldesk/text-core/speaker-attribution': '../../packages/text-core/speaker-attribution.ts',
    '@noveldesk/text-core/identity/parser': '../../packages/text-core/identity/parser.ts',
    '@noveldesk/text-core/identity/reader': '../../packages/text-core/identity/reader.ts',
    '@noveldesk/text-core/identity/ai': '../../packages/text-core/identity/ai.ts',
    '@noveldesk/text-core/identity/provider': '../../packages/text-core/identity/provider.ts',
    '@noveldesk/text-core/identity/sync': '../../packages/text-core/identity/sync.ts',
    '@noveldesk/text-core/identity/tts': '../../packages/text-core/identity/tts.ts',
    '@noveldesk/text-core/identity/workflow': '../../packages/text-core/identity/workflow.ts',
  },
  bundle: true,
  charset: 'utf8',
  entryPoints: {
    index: 'src/index.ts',
    worker: 'src/worker.ts',
    'db/migrate': 'src/db/migrate.ts',
    'cli/id-v2-migration': 'src/cli/id-v2-migration.ts',
  },
  external: ['./db/migrate.js'],
  format: 'esm',
  legalComments: 'none',
  logLevel: 'info',
  outdir,
  packages: 'external',
  platform: 'node',
  target: 'node22',
});

await mkdir(path.join(outdir, 'db'), { recursive: true });
await copyFile(path.join(serverRoot, 'src/db/schema.sql'), path.join(outdir, 'db/schema.sql'));

const migrationsSource = path.join(serverRoot, 'src/db/migrations');
const migrationsOutput = path.join(outdir, 'db/migrations');
const migrationFiles = (await readdir(migrationsSource, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
  .map((entry) => entry.name)
  .sort();

await mkdir(migrationsOutput, { recursive: true });
await Promise.all(
  migrationFiles.map((fileName) =>
    copyFile(path.join(migrationsSource, fileName), path.join(migrationsOutput, fileName)),
  ),
);
