import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { formatDeveloperError, runDevelopmentIteration } from './development';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

it('runs the generated fixture preview and reports build locations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moya-extension-dev-'));
  roots.push(root);
  await cp(resolve('packages/extension-runtime/examples/text-catalog'), root, { recursive: true });
  const preview = await runDevelopmentIteration(root, {
    method: 'source.getContent',
    input: join(root, 'content-input.json'),
    fixture: join(root, 'fixtures.json'),
  });
  expect(preview).toMatchObject({ method: 'source.getContent', result: { kind: 'text' } });
  if (!('assets' in preview) || !preview.assets) throw new Error('preview_assets_missing');
  expect(preview.assets[0]).toMatchObject({
    contentType: 'text/plain',
    byteLength: expect.any(Number),
  });

  await writeFile(join(root, 'empty-fixtures.json'), '[]');
  await expect(
    runDevelopmentIteration(root, {
      method: 'source.getContent',
      input: join(root, 'content-input.json'),
      fixture: join(root, 'empty-fixtures.json'),
    }),
  ).rejects.toThrow('fixture_missing:GET:https://catalog.example/chapter.txt');

  await writeFile(join(root, 'src/index.ts'), 'export default { broken: ; };');
  await expect(runDevelopmentIteration(root, {})).rejects.toSatisfy((error: unknown) => {
    const diagnostic = formatDeveloperError(error);
    return diagnostic.includes('src/index.ts:1:') && diagnostic.includes('Unexpected');
  });
});
