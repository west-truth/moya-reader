import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const runtime = path.resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(runtime, 'utf8'));
const guard = path.resolve(process.argv[3] ?? path.join(path.dirname(runtime), manifest.profileGuard));
const node = path.resolve(path.dirname(runtime), manifest.node);
const launcher = fileURLToPath(new URL('./embedded-server.mjs', import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), 'Moya recovery 한글 '));
const children = [];
function start() {
  const child = spawn(guard, [profile, node, launcher, runtime, profile, '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events = [];
  createInterface({ input: child.stdout }).on('line', (line) => events.push(JSON.parse(line)));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const value = { child, events, exited };
  children.push(value);
  return value;
}
async function ready(server) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const failure = server.events.find((event) => event.event === 'error');
    assert(!failure, failure?.message);
    const result = server.events.find((event) => event.event === 'ready');
    if (result) return result;
    assert.equal(server.child.exitCode, null, 'Guard exited before readiness');
    await delay(100);
  }
  throw new Error('Recovery timed out');
}
try {
  const first = start();
  const initial = await ready(first);
  const registration = await fetch(`${initial.url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'recovery-proof',
      password: 'recovery-proof-password',
      setupCode: initial.authToken,
    }),
  });
  assert(registration.ok);
  const duplicate = start();
  assert.equal(await duplicate.exited, 1);
  assert(duplicate.events.some((event) => event.event === 'error'));
  const owner = JSON.parse(await readFile(path.join(profile, 'server.lock'), 'utf8'));
  process.kill(owner.pid, 'SIGKILL'); // Only our synthetic profile's launcher.
  assert.equal(await first.exited, 1);
  const second = start();
  const recovered = await ready(second);
  assert(second.events.some((event) => event.phase === 'recovering'));
  assert.equal(recovered.url, initial.url);
  assert.equal(recovered.authToken, initial.authToken);
  assert.equal((await fetch(`${recovered.url}/api/auth/status`).then((r) => r.json())).setupRequired, false);
  assert.equal(
    (await fetch(`${recovered.url}/api/books`, { headers: { Authorization: `Bearer ${recovered.authToken}` } })).status,
    200,
  );
  second.child.stdin.end();
  assert.equal(await second.exited, 0);
  await assert.rejects(readFile(path.join(profile, 'server.lock')), { code: 'ENOENT' });
  const credentials = JSON.parse(await readFile(path.join(profile, 'server-credentials.json'), 'utf8'));
  const occupied = createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(credentials.ports.api, '127.0.0.1', resolve);
  });
  try {
    const blocked = start();
    assert.equal(await blocked.exited, 1);
    assert(blocked.events.some((event) => event.event === 'error' && /포트 .*사용 중/.test(event.message)));
    await assert.rejects(readFile(path.join(profile, 'server.lock')), { code: 'ENOENT' });
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
  const afterCollision = start();
  const resumed = await ready(afterCollision);
  assert.equal(resumed.authToken, initial.authToken);
  assert.equal((await fetch(`${resumed.url}/api/auth/status`).then((r) => r.json())).setupRequired, false);
  afterCollision.child.stdin.end();
  assert.equal(await afterCollision.exited, 0);
  console.log(
    JSON.stringify({
      crashRecovery: true,
      accountPreserved: true,
      ownerTokenPreserved: true,
      duplicateBlocked: true,
      occupiedApiPortPreserved: true,
      normalShutdown: true,
    }),
  );
} finally {
  for (const item of children) item.child.stdin.end();
}
