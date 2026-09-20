import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

test('builds an SDK consumed outside the workspace with NodeNext and Bundler types', async () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist', 'audit-stale.txt'), 'non-secret regression marker');
  execFileSync(process.execPath, [join(root, 'build.mjs')]);
  await assert.rejects(access(join(root, 'dist', 'audit-stale.txt')));
  const folder = await mkdtemp(join(tmpdir(), 'moya-sdk-consumer-'));
  try {
    const installed = join(folder, 'node_modules', '@moya', 'extension-sdk');
    await mkdir(installed, { recursive: true });
    await cp(join(root, 'dist'), join(installed, 'dist'), { recursive: true });
    await cp(join(root, 'package.json'), join(installed, 'package.json'));
    await writeFile(join(folder, 'package.json'), '{"type":"module"}');
    await writeFile(
      join(folder, 'index.ts'),
      `
      import {defineExtension, defineSource, type SourceDefinition} from '@moya/extension-sdk';
      const source: SourceDefinition = defineSource({
        id:'org.example.test',
        async listWorks(input){
          return {items:[],browse:{activeMode:input.browseMode ?? 'popular',availableModes:['popular','search'],
            filters:[{id:'query',position:0,kind:'text',label:'Query',defaultValue:''}]}};
        },
        async getWork(){return {id:'one',title:'One'}},
        async listReleases(){return {items:[]}},
        async getContent(_input,ctx){return {kind:'text',asset:await ctx.textAsset('Hello')}}
      });
      const extension = defineExtension({sources:[source]});
      if(typeof extension !== 'function') throw Error('not executable');
    `,
    );
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    for (const [module, moduleResolution] of [
      ['NodeNext', 'NodeNext'],
      ['ESNext', 'Bundler'],
    ]) {
      await writeFile(
        join(folder, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { target: 'ES2022', module, moduleResolution, strict: true, types: [], outDir: 'out' },
          files: ['index.ts'],
        }),
      );
      execFileSync(process.execPath, [tsc, '-p', join(folder, 'tsconfig.json')], { cwd: folder });
    }
    execFileSync(process.execPath, [join(folder, 'out', 'index.js')], { cwd: folder });
    const declarations = await readFile(join(installed, 'dist', 'index.d.ts'), 'utf8');
    assert.match(declarations, /source-browse\.js/);
    assert.doesNotMatch(declarations, /extension-contracts|workspace:/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
