import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const mainPath = path.join(repoRoot, 'src', 'main.tsx');
const stylesDir = path.join(repoRoot, 'src', 'styles');
const legacyStylesPath = path.join(repoRoot, 'src', 'styles.css');

const expectedStyleImports = [
  './styles/tokens.css',
  './styles/base.css',
  './styles/shell.css',
  './styles/library.css',
  './styles/chapters.css',
  './styles/reader-shell.css',
  './styles/reader-content.css',
  './styles/reader-addons.css',
  './styles/analysis.css',
  './styles/reader-tools.css',
  './styles/dialogs-import.css',
  './styles/external-sources.css',
  './styles/settings-sync.css',
  './styles/feedback.css',
  './styles/responsive.css',
];

const appRuntimeStyles = path.join(repoRoot, 'src', 'App.tsx');
const runtimeCustomPropertyOwners = new Map(
  [
    '--reading-background',
    '--reading-brightness',
    '--reading-first-line-indent',
    '--reading-font-family',
    '--reading-font-weight',
    '--reading-foreground',
    '--reading-letter-spacing',
    '--reading-margin-y',
    '--reading-text-align',
  ].map((customProperty) => [customProperty, appRuntimeStyles]),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function lineCount(source) {
  const lines = source.split(/\r?\n/);
  return source.endsWith('\n') ? lines.length - 1 : lines.length;
}

function assertBalancedBraces(source, fileName) {
  let depth = 0;
  let quote = '';
  let inComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (inComment) {
      if (character === '*' && next === '/') {
        inComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }

    if (character === '/' && next === '*') {
      inComment = true;
      index += 1;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      assert(depth >= 0, `${fileName} has an unmatched closing brace`);
    }
  }

  assert(!inComment, `${fileName} has an unterminated comment`);
  assert(!quote, `${fileName} has an unterminated string`);
  assert(depth === 0, `${fileName} has ${depth} unmatched opening brace(s)`);
}

function collectMatches(source, pattern) {
  return new Set([...source.matchAll(pattern)].map((match) => match[1]));
}

const mainSource = fs.readFileSync(mainPath, 'utf8');
const actualStyleImports = [...mainSource.matchAll(/^import ['"](\.\/styles\/[^'"]+\.css)['"];?$/gm)].map(
  (match) => match[1],
);

assert(!fs.existsSync(legacyStylesPath), 'src/styles.css must be removed after explicit entry imports are in place');
assert(
  JSON.stringify(actualStyleImports) === JSON.stringify(expectedStyleImports),
  `Unexpected CSS import order in src/main.tsx:\n${actualStyleImports.join('\n')}`,
);

const expectedFileNames = expectedStyleImports.map((styleImport) => path.basename(styleImport)).sort();
const actualFileNames = fs
  .readdirSync(stylesDir)
  .filter((fileName) => fileName.endsWith('.css'))
  .sort();
assert(
  JSON.stringify(actualFileNames) === JSON.stringify(expectedFileNames),
  `CSS file set does not match src/main.tsx imports:\n${actualFileNames.join('\n')}`,
);

const cssSources = expectedStyleImports.map((styleImport) => {
  const fileName = path.basename(styleImport);
  const source = fs.readFileSync(path.join(stylesDir, fileName), 'utf8');
  const lines = lineCount(source);

  assert(!/@import\b/.test(source), `${fileName} uses @import; keep the order explicit in src/main.tsx`);
  assertBalancedBraces(source, fileName);

  return { fileName, lines, source };
});

const cssWithoutComments = cssSources.map(({ source }) => source.replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
const cssDefinitions = collectMatches(cssWithoutComments, /(--[\w-]+)\s*:/g);
const cssUses = collectMatches(cssWithoutComments, /var\(\s*(--[\w-]+)/g);

for (const [customProperty, ownerPath] of runtimeCustomPropertyOwners) {
  const ownerSource = fs.readFileSync(ownerPath, 'utf8');
  assert(
    ownerSource.includes(`'${customProperty}'`) || ownerSource.includes(`"${customProperty}"`),
    `${customProperty} is not defined by its runtime owner ${path.relative(repoRoot, ownerPath)}`,
  );
}

const undefinedVariables = [...cssUses]
  .filter((customProperty) => !cssDefinitions.has(customProperty) && !runtimeCustomPropertyOwners.has(customProperty))
  .sort();
assert(undefinedVariables.length === 0, `Undefined CSS variables:\n${undefinedVariables.join('\n')}`);

const totalLines = cssSources.reduce((sum, { lines }) => sum + lines, 0);
console.log(
  `CSS check passed: ${cssSources.length} files, ${totalLines} lines, ${cssDefinitions.size} tokens, ` +
    `${runtimeCustomPropertyOwners.size} runtime custom property.`,
);
