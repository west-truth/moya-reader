import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { examplePackageManifest } from '../../src/test/extension-package-fixture';
import { buildProject, checkProjectPackage, runProjectSource } from './project';
import { verifyMoyaExtension } from '../../src/extensions/packages/package-archive';

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
const source = `import {defineExtension,defineSource} from '@moya/extension-sdk';
import {title} from './title';
export default defineExtension({sources:[defineSource({
 id:'org.example.catalog.source',
 async listWorks(input,ctx){return {items:input.query==='missing'?[]:[{id:'work',title}],nextCursor:'opaque=2'}},
 async getWork(){return {id:'work',title}},
 async listReleases(){return {items:[{id:'second',title:'2',order:2},{id:'first',title:'1',order:1}]}},
 async getContent(input,ctx){return {kind:'text',asset:await ctx.http.asset({url:'https://catalog.example/text'})}}
})]});`;

async function project(code = source) {
  const folder = await mkdtemp(resolve(tmpdir(), 'moya-extension-test-'));
  folders.push(folder);
  await mkdir(resolve(folder, 'src'));
  await writeFile(resolve(folder, 'manifest.json'), JSON.stringify(examplePackageManifest()));
  await writeFile(resolve(folder, 'LICENSE'), 'Synthetic test license');
  await writeFile(resolve(folder, 'src/index.ts'), code);
  await writeFile(resolve(folder, 'src/title.ts'), `export const title: string = 'Synthetic work';`);
  return folder;
}

describe('extension folder development and packaged execution', () => {
  it('bundles the storage SDK and returns staged changes without accessing developer files', async () => {
    const folder = await project(
      source.replace(
        'async listWorks(input,ctx){return',
        "async listWorks(input,ctx){const saved=await ctx.storage.get('label');await ctx.storage.set('label', saved || 'first');await ctx.storage.remove('obsolete');return",
      ),
    );
    const manifest = examplePackageManifest();
    manifest.requestedAccess.storageKiB = 4;
    await writeFile(resolve(folder, 'manifest.json'), JSON.stringify(manifest));
    const pkg = await buildProject(folder);
    await checkProjectPackage(pkg);
    const run = await runProjectSource(
      pkg,
      'source.listWorks',
      { sourceId: 'org.example.catalog.source' },
      { state: { label: 'saved' } },
    );
    expect(run.stateChanges).toEqual({
      readKeys: ['label', 'obsolete'],
      writes: [{ key: 'label', value: 'saved' }, { key: 'obsolete' }],
    });
  });
  it('bundles TS/local modules, validates without network, and reuses exactly the packaged JS', async () => {
    const folder = await project();
    const pkg = await buildProject(folder);
    expect((await buildProject(folder)).digest).toBe(pkg.digest);
    await checkProjectPackage(pkg);
    const reopened = await verifyMoyaExtension(pkg.archive);
    expect(reopened.source).toBe(pkg.source);
    const input = { sourceId: 'org.example.catalog.source' };
    expect((await runProjectSource(reopened, 'source.listWorks', input)).result).toMatchObject({
      items: [{ id: 'work' }],
      nextCursor: 'opaque=2',
    });
    expect((await runProjectSource(pkg, 'source.listWorks', { ...input, query: 'missing' })).result).toMatchObject({
      items: [],
    });
    expect((await runProjectSource(pkg, 'source.listReleases', { ...input, workId: 'work' })).result).toMatchObject({
      items: [{ order: 2 }, { order: 1 }],
    });
    const body = '원문 첫 줄\r\n\r\n  둘째 줄\n';
    const downloaded = await runProjectSource(
      pkg,
      'source.getContent',
      { ...input, workId: 'work', releaseId: 'first' },
      {
        fixtures: [{ url: 'https://catalog.example/text', body }],
      },
    );
    expect(downloaded.assets[0].bytes).toEqual(Buffer.from(body));
    await expect(
      runProjectSource(pkg, 'source.getContent', { ...input, workId: 'work', releaseId: 'first' }),
    ).rejects.toThrow();
  });

  it('uses another source structure for image assets and does not trust invented asset references', async () => {
    const folder = await project(
      source
        .replace("kind:'text',asset:", "kind:'images',assets:[")
        .replace("url:'https://catalog.example/text'})", "url:'https://catalog.example/text'})]"),
    );
    const manifest = JSON.parse(await readFile(resolve(folder, 'manifest.json'), 'utf8'));
    manifest.extension.contributes.externalSources[0].seriesProfile = { kind: 'image_series', archiveFormat: 'cbz' };
    manifest.extension.contributes.externalSources[0].capabilities = [
      'browse',
      'release-list',
      'release-download',
      'image-content',
    ];
    await writeFile(resolve(folder, 'manifest.json'), JSON.stringify(manifest));
    const pkg = await buildProject(folder);
    await checkProjectPackage(pkg);
    const input = { sourceId: 'org.example.catalog.source', workId: 'work', releaseId: 'first' };
    const result = await runProjectSource(pkg, 'source.getContent', input, {
      fixtures: [{ url: 'https://catalog.example/text', body: 'synthetic image bytes', contentType: 'image/png' }],
    });
    expect(result.assets[0].contentType).toBe('image/png');
    const forged = await buildProject(
      await project(
        source.replace(
          "await ctx.http.asset({url:'https://catalog.example/text'})",
          `{handle:'invented',byteLength:1,sha256:'${'0'.repeat(64)}',contentType:'text/plain'}`,
        ),
      ),
    );
    await expect(runProjectSource(forged, 'source.getContent', input)).rejects.toThrow('source_asset_unavailable');
  });

  it('rejects Node imports, dynamic imports, escaping project imports and malformed result data', async () => {
    for (const code of [
      `import fs from 'node:fs'; export default ()=>fs.readFileSync('secret')`,
      `export default ()=>import('./title')`,
      `import other from '../../outside'; export default other`,
    ])
      await expect(buildProject(await project(code))).rejects.toThrow();
    const pkg = await buildProject(
      await project(source.replace("id:'work',title}],nextCursor", "id:'work',title},{id:'work',title}],nextCursor")),
    );
    await expect(runProjectSource(pkg, 'source.listWorks', { sourceId: 'org.example.catalog.source' })).rejects.toThrow(
      'invalid_source_result',
    );
  });

  it('does not execute package scripts and rejects descriptor/implementation mismatches', async () => {
    const folder = await project(source.replace("id:'org.example.catalog.source'", "id:'org.example.wrong.source'"));
    await writeFile(resolve(folder, 'package.json'), JSON.stringify({ scripts: { prepare: 'must-never-run' } }));
    const pkg = await buildProject(folder);
    await expect(checkProjectPackage(pkg)).rejects.toThrow('source_manifest_mismatch');
  });
});
