import { readFile, mkdir, writeFile } from 'node:fs/promises';
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
// The public artifact must not depend on workspace paths or an application runtime.
if (/\b(?:import|export)\s.*\bfrom\s*['"]/.test(javascript + declarations))
  throw new Error('Standalone SDK unexpectedly imports another module.');
const dist = new URL('./dist/', import.meta.url);
await mkdir(dist, { recursive: true });
await Promise.all([
  writeFile(new URL('index.js', dist), javascript),
  writeFile(new URL('index.d.ts', dist), declarations),
  readFile(new URL('../../LICENSE', import.meta.url)).then((license) => writeFile(new URL('LICENSE', dist), license)),
]);
console.log('Built standalone extension SDK (JavaScript, declarations, license).');
