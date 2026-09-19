import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { scaffoldProject } from './scaffold';
import { buildProject, checkProjectPackage, runProjectSource } from './project';
import { verifyMoyaExtension } from '../../src/extensions/packages/package-archive';

const roots: string[] = [];
async function target() {
  const root = await mkdtemp(join(tmpdir(), 'moya-scaffold-'));
  roots.push(root);
  return join(root, 'extension');
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(['text', 'images'])(
  'generates an independently located %s project that builds and executes packaged content',
  async (kind) => {
    const folder = await target();
    const id = 'org.example.generated';
    await scaffoldProject(folder, { id, kind, name: 'Generated source' });
    const pkg = await buildProject(folder);
    await checkProjectPackage(pkg);
    const reopened = await verifyMoyaExtension(pkg.archive);
    const input = JSON.parse(await readFile(join(folder, 'content-input.json'), 'utf8'));
    expect(input.sourceId).toBe(id + '.source');
    const fixtures = JSON.parse(await readFile(join(folder, 'fixtures.json'), 'utf8'));
    const output = await runProjectSource(reopened, 'source.getContent', input, { fixtures });
    expect(output.result).toMatchObject({ kind });
    expect(output.assets.length).toBeGreaterThan(0);
    expect(output.assets.every((asset) => asset.bytes.length > 0)).toBe(true);
    expect(pkg.manifest.extension).toMatchObject({ id, name: 'Generated source' });
    expect(await readFile(join(folder, 'src/index.ts'), 'utf8')).not.toContain('org.example.text-catalog');
    const readme = await readFile(join(folder, 'README.md'), 'utf8');
    expect(readme).toContain('moya-extension dev');
    expect(readme).toContain('moya-extension pack');
  },
);

it('rejects existing targets without overwriting user files', async () => {
  const folder = await target();
  await writeFile(folder, 'important');
  await expect(scaffoldProject(folder, { id: 'org.example.source', kind: 'text' })).rejects.toThrow(
    'project_target_exists',
  );
  expect(await readFile(folder, 'utf8')).toBe('important');
});

it('validates identifiers and template kind before creating files', async () => {
  const folder = await target();
  await expect(scaffoldProject(folder, { id: 'invalid / identifier', kind: 'text' })).rejects.toThrow();
  await expect(scaffoldProject(folder, { id: 'org.example.source', kind: 'apk' })).rejects.toThrow(
    'invalid_project_kind',
  );
  await expect(access(folder)).rejects.toThrow();
});
