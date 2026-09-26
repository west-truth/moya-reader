import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startEmbeddedServer } from './embedded-server.mjs';

const runtimeFile = path.resolve(process.argv[2]);
const original = JSON.parse(await readFile(runtimeFile, 'utf8'));
assert(original.collectorExecutable, 'Packaged collector must exist in the original runtime');
const missingRuntime = path.join(path.dirname(runtimeFile), `runtime-collector-missing-${randomUUID()}.json`);
const profileDir = await mkdtemp(path.join(tmpdir(), 'Moya collector failure proof '));
await writeFile(missingRuntime, JSON.stringify({ ...original, collectorExecutable: 'collector/missing-sidecar.exe' }));
let server;
let passed = false;
try {
  server = await startEmbeddedServer({ runtimeFile: missingRuntime, profileDir });
  const registration = await fetch(`${server.url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'collector-failure-proof',
      password: 'collector proof account password',
      setupCode: server.authToken,
    }),
  });
  assert.equal(registration.status, 201, 'Synthetic owner account setup failed');
  const headers = { Authorization: `Bearer ${server.authToken}` };
  const books = await fetch(`${server.url}/api/books`, { headers });
  assert.equal(books.status, 200, 'Library should remain usable when the collector cannot start');
  const collector = await fetch(`${server.url}/api/integrations/webnovel-metadata/health`, { headers });
  assert.equal(collector.status, 503, 'Collector failure was hidden');
  assert.equal(collector.headers.get('cache-control'), 'no-store');
  await server.stop();
  server = undefined;
  passed = true;
  console.log(JSON.stringify({ libraryAvailable: true, collectorFailureVisible: true }));
} finally {
  await server?.stop().catch(() => undefined);
  await rm(missingRuntime, { force: true });
  if (passed) await rm(profileDir, { recursive: true, force: true });
  else console.error(`Collector failure profile retained for diagnostics: ${profileDir}`);
}
