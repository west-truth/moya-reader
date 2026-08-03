import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const inventoryPath = path.join(repositoryRoot, 'third_party', 'production-license-inventory.json');
const policyPath = path.join(repositoryRoot, 'third_party', 'license-release-policy.json');
const apacheLicensePath = path.join(repositoryRoot, 'LICENSE');
const canonicalApacheLicenseSha256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
const sourceReleaseGate = process.argv.includes('--source-release');
const releaseGate = process.argv.includes('--release');
const checkOnly = process.argv.includes('--check') || sourceReleaseGate || releaseGate;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function hasCanonicalApacheLicense() {
  if (!existsSync(apacheLicensePath)) return false;
  const normalizedLicense = `${readFileSync(apacheLicensePath, 'utf8').replace(/\r\n/g, '\n').trimEnd()}\n`;
  return createHash('sha256').update(normalizedLicense).digest('hex') === canonicalApacheLicenseSha256;
}

function productionLicenseReport() {
  const pnpmScript = process.env.npm_execpath;
  const executable = pnpmScript ? process.execPath : process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const args = [...(pnpmScript ? [pnpmScript] : []), 'licenses', 'list', '--prod', '--json'];
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) fail(result.stderr || result.error?.message || 'pnpm production license inventory failed.');
  return JSON.parse(result.stdout);
}

function buildInventory(report) {
  const components = [];
  for (const [reportedLicense, packages] of Object.entries(report)) {
    for (const packageRecord of packages) {
      for (const version of packageRecord.versions) {
        components.push({
          ecosystem: 'npm',
          name: packageRecord.name,
          version,
          license: packageRecord.license || reportedLicense,
          ...(packageRecord.homepage ? { homepage: packageRecord.homepage } : {}),
        });
      }
    }
  }
  components.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  const byLicense = {};
  for (const component of components) byLicense[component.license] = (byLicense[component.license] ?? 0) + 1;
  return {
    format: 'noveldesk-production-license-inventory',
    version: 1,
    scope: 'pnpm production dependencies for the web and Hosted server workspaces',
    source: 'pnpm licenses list --prod --json',
    summary: {
      componentCount: components.length,
      byLicense: Object.fromEntries(Object.entries(byLicense).sort(([left], [right]) => left.localeCompare(right))),
    },
    components,
  };
}

function verifyPolicy(inventory) {
  const policy = readJson(policyPath);
  if (policy.projectLicense === 'Apache-2.0' && !hasCanonicalApacheLicense()) {
    fail('Project LICENSE does not match the canonical Apache License 2.0 text.');
  }
  const componentIds = new Set(inventory.components.map((item) => `${item.name}@${item.version}`));
  const missingFiles = policy.requiredNoticeFiles.filter((file) => !existsSync(path.join(repositoryRoot, file)));
  if (missingFiles.length) fail(`Required notice files are missing: ${missingFiles.join(', ')}`);
  const staleExceptions = policy.componentExceptions
    .map((item) => item.component)
    .filter((component) => !componentIds.has(component));
  if (staleExceptions.length) fail(`License policy refers to absent components: ${staleExceptions.join(', ')}`);
  const unclassified = inventory.components.filter(
    (item) => !item.license || /^(unknown|unlicensed)$/i.test(item.license),
  );
  if (unclassified.length) {
    fail(`Production dependencies with no license classification: ${unclassified.map((item) => item.name).join(', ')}`);
  }
  if (sourceReleaseGate || releaseGate) {
    const blockers = [];
    if (policy.projectLicense !== 'Apache-2.0' || !hasCanonicalApacheLicense()) blockers.push('project-license');
    if (releaseGate) blockers.push(...policy.releaseBlockers);
    if (blockers.length) fail(`Public release license gate is blocked: ${[...new Set(blockers)].join(', ')}`);
  }
}

const inventory = buildInventory(productionLicenseReport());
const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
verifyPolicy(inventory);

if (checkOnly) {
  if (!existsSync(inventoryPath) || readFileSync(inventoryPath, 'utf8') !== serialized) {
    fail('Production license inventory is stale. Run pnpm licenses:generate.');
  }
  process.stdout.write(`Production license inventory verified (${inventory.summary.componentCount} npm components).\n`);
} else {
  writeFileSync(inventoryPath, serialized, 'utf8');
  process.stdout.write(`Wrote production license inventory (${inventory.summary.componentCount} npm components).\n`);
}
