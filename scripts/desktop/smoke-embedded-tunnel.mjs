import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setDefaultResultOrder } from 'node:dns';
import { setTimeout as delay } from 'node:timers/promises';
import { startEmbeddedServer } from './embedded-server.mjs';
import { startCloudflareSharing } from './embedded-tunnel.mjs';

// Opt-in network proof: publishes only a new, synthetic, empty test library.
const runtimeFile = process.argv[2];
setDefaultResultOrder('ipv4first');
if (!runtimeFile) throw new Error('Pass a staged embedded runtime.json');
const profileDir = await mkdtemp(path.join(tmpdir(), 'Moya tunnel proof '));
let server;
let sharing;
try {
  server = await startEmbeddedServer({ runtimeFile, profileDir });
  const password = randomUUID();
  const register = await fetch(`${server.url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tunnel-proof', password, setupCode: server.authToken }),
  });
  assert(register.ok);
  console.log('Synthetic account ready; connecting Quick Tunnel');
  sharing = await startCloudflareSharing({
    url: server.url,
    executable: server.cloudflared,
    profileDir,
    port: server.tunnelPort,
  });
  const request = (resource, options = {}) =>
    fetch(`${sharing.url}${resource}`, {
      ...options,
      signal: AbortSignal.timeout(10_000),
    });
  // Edge registration precedes DNS/route propagation on some networks.
  let response;
  const deadline = Date.now() + 45_000;
  do {
    response = await request('/api/auth/status').catch(() => undefined);
    if (response?.ok) break;
    await delay(1000);
  } while (Date.now() < deadline);
  assert(response?.ok, 'Public HTTPS endpoint did not become reachable');
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/api/books')).status, 401);
  assert.equal((await request('/api/books', { headers: { Authorization: `Bearer ${server.authToken}` } })).status, 403);
  assert.equal((await request('/api/auth/status', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: sharing.url },
    body: JSON.stringify({ username: 'tunnel-proof', password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert(cookie?.includes('Secure'), 'HTTPS session cookie must be Secure');
  assert.equal((await request('/api/books', { headers: { Cookie: cookie.split(';')[0] } })).status, 200);
  await sharing.stop();
  const revoked = await request('/api/books').catch(() => undefined);
  assert(!revoked?.ok, 'Revoked tunnel must not serve the library');
  assert.equal(
    (await fetch(`${server.url}/api/books`, { headers: { Authorization: `Bearer ${server.authToken}` } })).status,
    200,
  );
  console.log(
    JSON.stringify({
      quickTunnel: true,
      httpsLogin: true,
      secureCookie: true,
      ownerTokenBlocked: true,
      revoked: true,
      localStillAvailable: true,
    }),
  );
} finally {
  await sharing?.stop();
  await server?.stop();
}
