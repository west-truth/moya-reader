import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startEmbeddedServer } from './embedded-server.mjs';

const runtimeFile = path.resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(runtimeFile, 'utf8'));
assert(manifest.collectorExecutable, 'Packaged collector is missing from runtime manifest');
assert(manifest.collectorBrowsers, 'Packaged login browser is missing from runtime manifest');
const runtimeDir = path.dirname(runtimeFile);
const executable = path.resolve(runtimeDir, manifest.collectorExecutable);
const browserDir = path.resolve(runtimeDir, manifest.collectorBrowsers);
assert((await stat(executable)).isFile());
assert((await stat(browserDir)).isDirectory());
const browserCheck = spawnSync(executable, ['--check-browser'], {
  windowsHide: true,
  timeout: 90_000,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserDir },
});
assert.equal(
  browserCheck.status,
  0,
  `Bundled browser failed to launch: ${browserCheck.error?.message ?? browserCheck.stderr?.toString().slice(-2000) ?? ''}`,
);

const profileDir = await mkdtemp(path.join(tmpdir(), 'Moya collector proof '));
let server;
let passed = false;
try {
  server = await startEmbeddedServer({ runtimeFile, profileDir });
  const endpoint = `${server.url}/api/integrations/webnovel-metadata`;
  const registration = await fetch(`${server.url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'collector-proof',
      password: 'collector proof account password',
      setupCode: server.authToken,
    }),
  });
  assert.equal(registration.status, 201, 'Synthetic owner account setup failed');
  const forbidden = await fetch(`${endpoint}/health`);
  assert.equal(forbidden.status, 401, 'Gateway allowed an unauthenticated request');
  const headers = { Authorization: `Bearer ${server.authToken}` };
  const response = await fetch(`${endpoint}/health`, { headers });
  assert.equal(response.status, 200, 'Gateway could not reach the packaged collector');
  const health = await response.json();
  assert.equal(health.service, 'webnovel-metadata-collector');
  assert.equal(health.api_version, 1);
  assert.equal(health.capabilities.adult_auth.browser_presentation, 'remote_frame');
  assert.equal(health.capabilities.adult_auth.available, true);
  assert(!JSON.stringify(health).includes('MOYA_COLLECTOR_SESSION_TOKEN'));
  const auth = await fetch(`${endpoint}/api/v1/auth/status`, { headers });
  assert.equal(auth.status, 200, 'Remote authentication status is unavailable');

  const result = { packageHealth: true, browserLaunch: true, remoteAuthStatus: true };
  if (process.argv.includes('--live')) {
    const url = new URL(`${endpoint}/api/v1/resolve`);
    url.searchParams.set('q', '전지적 독자 시점');
    const metadataResponse = await fetch(url, { headers, signal: AbortSignal.timeout(40_000) });
    assert.equal(metadataResponse.status, 200, 'Live metadata request failed at the gateway');
    const metadata = await metadataResponse.json();
    result.liveMetadataStatus = metadata.status;
    result.liveFailedPlatforms = metadata.failed_platforms;
    assert.equal(metadata.status, 'found', `Public site did not return a match: ${JSON.stringify(result)}`);
    assert(metadata.cover_ref, `Public site did not provide a cover reference: ${JSON.stringify(result)}`);
    const cover = await fetch(`${endpoint}/api/v1/covers/${metadata.cover_ref}`, {
      headers,
      signal: AbortSignal.timeout(40_000),
    });
    result.liveCoverStatus = cover.status;
    assert.equal(cover.status, 200, `Public cover fetch failed: ${JSON.stringify(result)}`);
    assert((await cover.arrayBuffer()).byteLength > 0);
    result.liveCoverFetched = true;
  }
  await server.stop();
  server = undefined;
  passed = true;
  console.log(JSON.stringify(result));
} finally {
  await server?.stop().catch(() => undefined);
  if (passed) await rm(profileDir, { recursive: true, force: true });
  else console.error(`Collector proof profile retained for diagnostics: ${profileDir}`);
}
