import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checks = ['code', 'web', 'settings', 'reader', 'discovery', 'extensions', 'native', 'deploy', 'text', 'apk'];
const allChecks = () => Object.fromEntries(checks.map((key) => [key, true]));

// Unknown paths and build/dependency changes deliberately select the full gate.
// These are coarse job boundaries, not an attempt to infer the import graph.
export function qualityScope(files, full = false) {
  if (full) return allChecks();
  const result = Object.fromEntries(checks.map((key) => [key, false]));
  for (const file of files) {
    if (/^(docs\/|.*\.md$|LICENSE|\.github\/(ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE))/.test(file)) continue;
    if (
      /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+)$/.test(
        file,
      ) ||
      /^(\.github\/workflows\/quality\.yml|scripts\/ci\/|\.npmrc|eslint\.config\.|\.prettier)/.test(file)
    )
      return allChecks();
    result.code = true;
    if (/^(src\/|apps\/web\/|public\/|index\.html$)/.test(file)) {
      result.web = true;
      // Shared UI/state changes can affect every browser flow.
      const shared = !file.startsWith('src/features/') || /^src\/features\/(extensions|external-sources)\//.test(file);
      result.settings ||= shared || /^src\/features\/reader-settings\//.test(file);
      result.reader ||= shared || /^src\/features\/(reader|fixed-document|tts|chapters|book-workspace)\//.test(file);
      result.discovery ||= shared || file.startsWith('src/features/discovery/');
      result.extensions ||= shared || /^src\/features\/(extensions|external-sources)\//.test(file);
      result.native ||= /^src\/(platform\/|test\/(platform-runtime|desktop-)|repositories\/tauri-)/.test(file);
    } else if (/^apps\/server\//.test(file)) {
      result.extensions ||= /\/(extensions|routes)\//.test(file);
      result.deploy ||= /\/(build\.mjs|src\/db\/|src\/server[^/]*|src\/index\.ts|src\/cli\/)/.test(file);
    } else if (/^src-tauri\//.test(file)) {
      result.native = true;
    } else if (/^services\/text-source-server\//.test(file)) {
      result.text = result.deploy = true;
    } else if (/^services\/apk-worker\//.test(file)) {
      result.apk = result.extensions = result.deploy = true;
    } else if (/^(deploy\/|compose[^/]*\.ya?ml$|\.dockerignore$|services\/)/.test(file)) {
      result.deploy = true;
    } else {
      // Shared contracts, tooling and new top-level areas need the full gate.
      return allChecks();
    }
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.env.QUALITY_BASE;
  const files = base
    ? execFileSync('git', ['diff', '--name-only', '-z', `${base}...HEAD`], { encoding: 'utf8' })
        .split('\0')
        .filter(Boolean)
    : [];
  const result = qualityScope(files, !base);
  console.log(JSON.stringify({ files: files.length, checks: result }, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(result)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  }
}
