import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { createSharingListener, startSharing } from './embedded-sharing.mjs';
import { fixedTunnelOrigin, startCloudflareSharing } from './embedded-tunnel.mjs';

async function withinFiveSeconds(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('network monitor timed out')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('HTTPS gateway admits only its public host/origin and never native bearer credentials', async () => {
  const received = [];
  const api = createServer((request, response) => {
    if (request.url === '/api/auth/status') return response.end(JSON.stringify({ setupRequired: false }));
    received.push(request.headers);
    response.end('ok');
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  let gateway;
  try {
    gateway = await createSharingListener({ url: `http://127.0.0.1:${api.address().port}`, publicOrigin: null });
    const request = (headers = {}, resource = '/api/books') =>
      new Promise((resolve, reject) => {
        const outgoing = httpRequest(`${gateway.url}${resource}`, { headers }, (response) => {
          response.resume();
          response.once('end', () => resolve({ status: response.statusCode }));
        });
        outgoing.once('error', reject);
        outgoing.end();
      });
    assert.equal((await request()).status, 403);
    gateway.setPublicOrigin('https://library.example.com');
    const host = { Host: 'library.example.com' };
    assert.equal((await request({ ...host, Origin: 'https://attacker.example.com' })).status, 403);
    assert.equal((await request({ ...host, Authorization: 'Bearer native-owner' })).status, 403);
    assert.equal((await request(host, '/api/auth/recover')).status, 403);
    assert.equal(
      (
        await request({
          ...host,
          Origin: 'https://library.example.com',
          Cookie: 'session=browser',
          'X-Forwarded-Proto': 'http',
          'X-Forwarded-Host': 'attacker.example.com',
        })
      ).status,
      200,
    );
    assert.equal(received.length, 1);
    assert.equal(received[0]['x-forwarded-proto'], 'https');
    assert.equal(received[0]['x-forwarded-host'], undefined);
    assert.equal(received[0].cookie, 'session=browser');
    await gateway.stop();
    await assert.rejects(request());
  } finally {
    await gateway?.stop();
    await new Promise((resolve) => api.close(resolve));
  }
});

test('revokes direct sharing when its network address disappears while the server stays up', async () => {
  const api = createServer((request, response) => {
    if (request.url === '/api/auth/status') return response.end(JSON.stringify({ setupRequired: false }));
    response.end('library is available');
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const localUrl = `http://127.0.0.1:${api.address().port}`;
  let attached = true;
  let sharing;
  try {
    let resolveDisconnected;
    const disconnected = new Promise((resolve) => {
      resolveDisconnected = resolve;
    });
    sharing = await startSharing({
      url: localUrl,
      host: '127.0.0.1',
      listInterfaces: () => (attached ? [{ name: 'test VPN', address: '127.0.0.1' }] : []),
      monitorIntervalMs: 10,
      onExit: resolveDisconnected,
    });
    assert.equal((await fetch(`${sharing.url}/api/books`)).status, 200);
    attached = false;
    assert.match(await withinFiveSeconds(disconnected), /네트워크 연결이 끊겼습니다/);
    await assert.rejects(fetch(`${sharing.url}/api/books`));
    assert.equal((await fetch(`${localUrl}/api/books`)).status, 200);
  } finally {
    await sharing?.stop();
    await new Promise((resolve) => api.close(resolve));
  }
});

test('fixed tunnel URL rejects HTTP and credentials; cancelled startup opens no listener', async () => {
  assert.equal(fixedTunnelOrigin('https://reader.example.com/'), 'https://reader.example.com');
  for (const value of [
    'http://reader.example.com',
    'https://user:secret@reader.example.com',
    'https://reader.example.com/path',
    'https://reader.example.com/?token=secret',
  ])
    assert.throws(() => fixedTunnelOrigin(value));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(startCloudflareSharing({ signal: controller.signal }), { name: 'AbortError' });
});
