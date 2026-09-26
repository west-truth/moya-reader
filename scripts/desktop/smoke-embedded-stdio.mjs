import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const runtime = path.resolve(process.argv[2]);
const profile = await mkdtemp(path.join(tmpdir(), 'Moya stdio 한글 '));
const launcher = fileURLToPath(new URL('./embedded-server.mjs', import.meta.url));
function start(profileDir) {
  const child = spawn(process.execPath, [launcher, runtime, profileDir, '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events = [];
  createInterface({ input: child.stdout }).on('line', (line) => events.push(JSON.parse(line)));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return { child, events, exited };
}
async function waitFor(check) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await delay(100);
  }
  throw new Error('Native protocol timeout');
}
const first = start(profile);
try {
  const ready = await waitFor(() => first.events.find((message) => message.event === 'ready'));
  assert.equal(
    (await fetch(`${ready.url}/api/books`, { headers: { Authorization: `Bearer ${ready.authToken}` } })).status,
    200,
  );
  const duplicate = start(profile);
  assert.equal(await duplicate.exited, 1);
  assert(duplicate.events.some((event) => event.event === 'error'));
  // EOF represents the native shell crashing. The launcher must still drain its children.
  first.child.stdin.end();
  assert.equal(await first.exited, 0);
  await assert.rejects(readFile(path.join(profile, 'server.lock')), { code: 'ENOENT' });
  const cancelled = start(await mkdtemp(path.join(tmpdir(), 'Moya cancelled 한글 ')));
  await waitFor(() => cancelled.events.find((event) => event.phase === 'initializing'));
  cancelled.child.stdin.write('shutdown\n');
  assert.equal(await cancelled.exited, 0);
  assert(!cancelled.events.some((event) => event.event === 'ready'));
  console.log('Private native protocol, duplicate start, parent EOF cleanup and startup cancellation passed');
} finally {
  first.child.stdin.end();
}
