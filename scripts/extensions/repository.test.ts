import { mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { scaffoldProject } from './scaffold';
import { buildProject } from './project';
import { buildRepositoryIndex } from './repository';
import { validateRepositoryIndex } from '../../src/extensions/packages/repository-contract';
const roots: string[] = [];
async function fixture(updates?: string) {
  const root = await mkdtemp(join(tmpdir(), 'moya-index-'));
  roots.push(root);
  const project = join(root, 'project');
  await scaffoldProject(project, { id: 'org.example.published', kind: 'text' });
  if (updates) {
    const manifest = JSON.parse(await readFile(join(project, 'manifest.json'), 'utf8'));
    manifest.updates = { repository: updates };
    await writeFile(join(project, 'manifest.json'), JSON.stringify(manifest));
  }
  const pkg = await buildProject(project);
  const archive = join(root, 'release #1.moyaext');
  await writeFile(archive, new Uint8Array(await pkg.archive.arrayBuffer()));
  return { root, archive };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('creates a host-accepted deterministic index from verified immutable archives', async () => {
  const url = 'https://extensions.example/release/index.json';
  const { root, archive } = await fixture(url);
  const index = await buildRepositoryIndex(root, url, 'Example');
  expect(validateRepositoryIndex(index, url)).toEqual(index);
  expect(await buildRepositoryIndex(root, url, 'Example')).toEqual(index);
  expect(index.packages[0]).toMatchObject({
    id: 'org.example.published',
    archive: './release%20%231.moyaext',
    sha256: createHash('sha256')
      .update(await readFile(archive))
      .digest('hex'),
  });
  expect(new URL(index.packages[0].archive, url).pathname).toBe('/release/release%20%231.moyaext');
});
it('rejects multiple releases of the same ID instead of silently choosing a version', async () => {
  const { root, archive } = await fixture();
  await copyFile(archive, join(root, 'other.moyaext'));
  await expect(buildRepositoryIndex(root, 'https://extensions.example/index.json')).rejects.toThrow(
    'repository_duplicate_package',
  );
});
it('rejects corrupt archives and mismatched declared update destinations', async () => {
  const { root, archive } = await fixture('https://other.example/index.json');
  await expect(buildRepositoryIndex(root, 'https://extensions.example/index.json')).rejects.toThrow(
    'repository_update_url_mismatch',
  );
  await writeFile(archive, 'not a package');
  await expect(buildRepositoryIndex(root, 'https://other.example/index.json')).rejects.toThrow();
});
