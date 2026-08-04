import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const codeFilePattern = /\.(?:rs|ts|tsx)$/i;
const sourcePrefixes = ['apps/server/src/', 'src/', 'src-tauri/src/'];

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

function normalize(filePath) {
  return filePath.replaceAll('\\', '/');
}

function isCandidate(filePath) {
  const normalized = normalize(filePath);
  return codeFilePattern.test(normalized) && sourcePrefixes.some((prefix) => normalized.startsWith(prefix));
}

function comparisonBase() {
  const explicitBase = process.env.FILE_SIZE_BASE_REF?.trim();
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

function lineCount(source) {
  if (!source) return 0;
  return source.split(/\r?\n/).length;
}

function hardLimit(filePath) {
  const normalized = normalize(filePath);
  if (/\.(?:test|spec)\.[^.]+$/i.test(normalized)) return 1_200;
  if (normalized.endsWith('.tsx')) return 500;
  if (/(?:^|\/)(?:hooks?|controllers?)(?:\/|$)/i.test(normalized)) return 500;
  return 800;
}

const { base, files } = changedFiles();
const violations = [];

for (const filePath of files) {
  const absolutePath = path.join(workspaceRoot, filePath);
  if (!fs.existsSync(absolutePath)) continue;

  const currentLines = lineCount(fs.readFileSync(absolutePath, 'utf8'));
  const baseline = git(['show', `${base}:${normalize(filePath)}`], { allowFailure: true, raw: true });
  const baselineLines = baseline === undefined ? undefined : lineCount(baseline);
  const limit = hardLimit(filePath);

  if (baselineLines === undefined) {
    if (currentLines > limit) {
      violations.push(`${filePath}: new file has ${currentLines} lines (limit ${limit})`);
    }
    continue;
  }

  if (baselineLines > limit && currentLines > baselineLines) {
    violations.push(
      `${filePath}: legacy oversized file grew from ${baselineLines} to ${currentLines} lines (limit ${limit})`,
    );
  } else if (baselineLines <= limit && currentLines > limit) {
    violations.push(`${filePath}: grew from ${baselineLines} to ${currentLines} lines (limit ${limit})`);
  }
}

if (violations.length) {
  console.warn('File-size diagnostic found files worth a responsibility review:');
  violations.forEach((violation) => console.warn(`- ${violation}`));
  console.warn(
    'This is advisory. Split only when responsibilities, dependencies, tests, or measured performance benefit.',
  );
} else {
  console.log(`File-size diagnostic found no threshold crossings in ${files.length} changed source file(s).`);
}
