import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import ts from 'typescript';

// Compile the same SDK the existing package builder injects. No second implementation or app imports.
const source = fileURLToPath(new URL('../extension-contracts/source-sdk.ts', import.meta.url));
const program = ts.createProgram([source], {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ES2020,
  strict: true,
  declaration: true,
  types: [],
  lib: ['lib.es2020.d.ts'],
  skipLibCheck: true,
  newLine: ts.NewLineKind.LineFeed,
});
const outputs = new Map();
const result = program.emit(undefined, (path, content) => outputs.set(basename(path), content));
const diagnostics = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics];
if (result.emitSkipped || diagnostics.length) {
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\n',
    }),
  );
}
const javascript = outputs.get('source-sdk.js');
const declarations = outputs.get('source-sdk.d.ts');
if (!javascript || !declarations) throw new Error('SDK build did not produce JavaScript and declarations.');
// Type-only browse contracts must travel with the SDK, rather than point into the workspace.
// Runtime JavaScript still has no imports. Use .js specifiers so NodeNext consumers can resolve the declarations.
if (ts.preProcessFile(javascript).importedFiles.length)
  throw new Error('Standalone SDK unexpectedly imports a runtime module.');
const types = new Map();
for (const [name, content] of outputs) {
  if (!name.endsWith('.d.ts')) continue;
  let rewritten = content;
  for (const imported of ts.preProcessFile(content).importedFiles) {
    if (!/^\.\/[a-z][a-z0-9-]*$/.test(imported.fileName) || !outputs.has(imported.fileName.slice(2) + '.d.ts'))
      throw new Error('Standalone SDK declaration escapes the distributable.');
    rewritten = rewritten
      .replaceAll(`'${imported.fileName}'`, `'${imported.fileName}.js'`)
      .replaceAll(`"${imported.fileName}"`, `"${imported.fileName}.js"`);
  }
  types.set(name === 'source-sdk.d.ts' ? 'index.d.ts' : name, rewritten);
}
const dist = new URL('./dist/', import.meta.url);
// Rebuild generated output so removed declarations/debug files cannot ship in a later tarball.
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await Promise.all([
  writeFile(new URL('index.js', dist), javascript),
  ...Array.from(types, ([name, content]) => writeFile(new URL(name, dist), content)),
  readFile(new URL('../../LICENSE', import.meta.url)).then((license) => writeFile(new URL('LICENSE', dist), license)),
]);
console.log('Built standalone extension SDK (JavaScript, declarations, license).');
