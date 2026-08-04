import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as prettier from 'prettier';

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const supportedFilePattern = /\.(?:css|js|json|jsx|mjs|ts|tsx|ya?ml)$/i;
const ignoredPrefixes = [
  'dist/',
  'node_modules/',
  'screenshots/',
  'smart-novel-reader-codex-pack/',
  'src-tauri/',
  'test_novel/',
  'ui-reference/',
];

function git(args, options = {}) {
  try {
    const output = execFileSync('git', args, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', options.allowFailure ? 'ignore' : 'pipe'],
    });
    return options.raw ? output : output.trim();
  } catch (error) {
    if (options.allowFailure) return undefined;
    throw error;
  }
}

function lines(value) {
  return value
    ? value
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function isCandidate(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  return supportedFilePattern.test(normalized) && !ignoredPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function comparisonBase() {
  const explicitBase = process.env.FORMAT_BASE_REF?.trim();
  if (explicitBase) return explicitBase;

  const githubBase = process.env.GITHUB_BASE_REF?.trim();
  if (githubBase) {
    const remoteBase = `origin/${githubBase}`;
    if (git(['rev-parse', '--verify', remoteBase], { allowFailure: true })) return remoteBase;
  }

  return undefined;
}

function changedFiles() {
  const result = new Set([
    ...lines(git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'])),
    ...lines(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', 'HEAD'])),
    ...lines(git(['ls-files', '--others', '--exclude-standard'])),
  ]);
  const base = comparisonBase();

  if (base) {
    lines(git(['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`])).forEach((file) => result.add(file));
  } else if (result.size === 0 && git(['rev-parse', '--verify', 'HEAD^'], { allowFailure: true })) {
    lines(git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD^', 'HEAD'])).forEach((file) => result.add(file));
  }

  return { base: base ?? 'HEAD', files: [...result].filter(isCandidate).sort() };
}

function readBaseline(base, filePath) {
  return git(['show', `${base}:${filePath.replaceAll('\\', '/')}`], { allowFailure: true, raw: true });
}

async function isFormatted(source, filePath) {
  const config = (await prettier.resolveConfig(filePath)) ?? {};
  return prettier.check(source, { ...config, filepath: filePath });
}

const { base, files } = changedFiles();
const violations = [];
const legacy = [];

for (const filePath of files) {
  const absolutePath = path.join(workspaceRoot, filePath);
  if (!fs.existsSync(absolutePath)) continue;

  const current = fs.readFileSync(absolutePath, 'utf8');
  if (await isFormatted(current, absolutePath)) continue;

  const baseline = readBaseline(base, filePath);
  if (baseline !== undefined && !(await isFormatted(baseline, absolutePath))) {
    legacy.push(filePath);
    continue;
  }
  violations.push(filePath);
}

if (legacy.length) {
  console.warn(`Formatting ratchet: ${legacy.length} changed legacy file(s) remain on the existing baseline.`);
}

if (violations.length) {
  console.error('Formatting check failed for new or previously formatted files:');
  violations.forEach((file) => console.error(`- ${file}`));
  console.error('Run pnpm exec prettier --write <files> for the listed paths.');
  process.exitCode = 1;
} else {
  console.log(`Formatting check passed for ${files.length} changed file(s).`);
}
