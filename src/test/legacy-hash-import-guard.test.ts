import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const legacyHashModule = path.join(workspaceRoot, 'src/domain/hash.ts');
const allowedProductionImports = [
  'src/domain/id-hash-contract.ts',
  'src/domain/parser/content-contract.ts',
  'src/services/import/browser-import-service.ts',
  'src/services/import/chapter-split-preview.ts',
  'src/services/import/local-book-attach-service.ts',
  'src/services/import/server-upload-import-service.ts',
  // Existing books can retain a v1 FNV source hash until the user reselects the exact original file.
  'src/storage/book-asset-store.ts',
  'src/storage/content-revision-read-handle.ts',
  'src/storage/content-revision-remote-state.ts',
  'src/storage/content-revisions.ts',
  'src/storage/id-v2-migration/hashes.ts',
  'src/storage/reader-query-store.ts',
  'src/sync/event-contract-translation.ts',
].sort();

function sourceFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(absolute));
    else if (/\.tsx?$/.test(entry.name)) result.push(absolute);
  }
  return result;
}

function isProduction(file: string): boolean {
  const relative = path.relative(workspaceRoot, file).replace(/\\/g, '/');
  return (
    !relative.includes('/test/') &&
    !/\.(?:test|spec|integration-fixture)\.tsx?$/.test(relative) &&
    !relative.includes('test-harness')
  );
}

function resolvesToLegacyHash(file: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const unresolved = path.resolve(path.dirname(file), specifier).replace(/\.js$/, '');
  return path.resolve(`${unresolved}.ts`) === legacyHashModule || path.resolve(unresolved) === legacyHashModule;
}

function importsLegacyHash(file: string): boolean {
  const source = fs.readFileSync(file, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return parsed.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !resolvesToLegacyHash(file, statement.moduleSpecifier.text)
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return false;
    return bindings.elements.some((element) =>
      ['stableId', 'hashSync', 'hashSyncRange'].includes((element.propertyName ?? element.name).text),
    );
  });
}

describe('legacy hash import guard', () => {
  it('allows FNV imports only in the explicit compatibility/deferred-migration boundary', () => {
    const imports = [path.join(workspaceRoot, 'src'), path.join(workspaceRoot, 'apps/server/src')]
      .flatMap(sourceFiles)
      .filter(isProduction)
      .filter(importsLegacyHash)
      .map((file) => path.relative(workspaceRoot, file).replace(/\\/g, '/'))
      .sort();

    expect(imports).toEqual(allowedProductionImports);
  });
});
