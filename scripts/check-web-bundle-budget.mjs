import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const distRoot = path.join(workspaceRoot, 'dist');
const budgets = {
  entryJsRaw: Number.parseInt(process.env.BUNDLE_ENTRY_JS_RAW_MAX ?? '660000', 10),
  entryJsGzip: Number.parseInt(process.env.BUNDLE_ENTRY_JS_GZIP_MAX ?? '186000', 10),
  entryCssRaw: Number.parseInt(process.env.BUNDLE_ENTRY_CSS_RAW_MAX ?? '56000', 10),
  entryCssGzip: Number.parseInt(process.env.BUNDLE_ENTRY_CSS_GZIP_MAX ?? '10000', 10),
};

function assertBudgetConfiguration() {
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid bundle budget ${name}: ${value}`);
  }
}

function assetPaths(html, pattern) {
  return [...html.matchAll(pattern)].map((match) => match[1].replace(/^\//, ''));
}

function measure(relativePath) {
  const absolutePath = path.join(distRoot, relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`Built entry asset is missing: ${relativePath}`);
  const content = fs.readFileSync(absolutePath);
  return { path: relativePath, raw: content.byteLength, gzip: gzipSync(content, { level: 9 }).byteLength };
}

function total(measurements, field) {
  return measurements.reduce((sum, item) => sum + item[field], 0);
}

function formatBytes(value) {
  return `${(value / 1024).toFixed(1)} KiB`;
}

function enforce(label, actual, maximum, failures) {
  if (actual <= maximum) return;
  failures.push(`${label}: ${formatBytes(actual)} exceeds ${formatBytes(maximum)}`);
}

assertBudgetConfiguration();
const indexPath = path.join(distRoot, 'index.html');
if (!fs.existsSync(indexPath)) throw new Error('dist/index.html is missing; run pnpm build first.');

const html = fs.readFileSync(indexPath, 'utf8');
const scripts = assetPaths(html, /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>/g).map(measure);
const styles = assetPaths(html, /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/g).map(measure);

if (scripts.length === 0) throw new Error('No module entry script was found in dist/index.html.');
if (styles.length === 0) throw new Error('No entry stylesheet was found in dist/index.html.');

const totals = {
  entryJsRaw: total(scripts, 'raw'),
  entryJsGzip: total(scripts, 'gzip'),
  entryCssRaw: total(styles, 'raw'),
  entryCssGzip: total(styles, 'gzip'),
};
const failures = [];
enforce('entry JS raw', totals.entryJsRaw, budgets.entryJsRaw, failures);
enforce('entry JS gzip', totals.entryJsGzip, budgets.entryJsGzip, failures);
enforce('entry CSS raw', totals.entryCssRaw, budgets.entryCssRaw, failures);
enforce('entry CSS gzip', totals.entryCssGzip, budgets.entryCssGzip, failures);

console.log(
  `Web bundle: JS ${formatBytes(totals.entryJsRaw)} raw / ${formatBytes(totals.entryJsGzip)} gzip; ` +
    `CSS ${formatBytes(totals.entryCssRaw)} raw / ${formatBytes(totals.entryCssGzip)} gzip.`,
);
if (failures.length) {
  console.warn('Web bundle diagnostic crossed a historical threshold:');
  failures.forEach((failure) => console.warn(`- ${failure}`));
  console.warn('This is advisory; decide from measured initial-load and interaction performance.');
} else {
  console.log('Web bundle diagnostic is within the recorded thresholds.');
}
