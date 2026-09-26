import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { createRequire } from 'node:module';
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

// HTTP/2 tunnel conversion can frame an empty command as HTTP/1.1 chunked.
// Use the real API parser: a permissive http.createServer stub misses its 415.
test('forwards empty chunked commands without inventing a body and preserves real streams', async () => {
  const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
  const api = require('fastify')();
  api.get('/api/auth/status', async () => ({ setupRequired: false }));
  api.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  api.all('/probe', async (req) => ({
    method: req.method,
    body: Buffer.isBuffer(req.body) ? [...req.body] : (req.body ?? null),
    contentType: req.headers['content-type'] ?? null,
  }));
  await api.listen({ host: '127.0.0.1', port: 0 });
  let sharing;
  try {
    sharing = await createSharingListener({ url: `http://127.0.0.1:${api.server.address().port}` });
    const request = (method, body, contentType) =>
      new Promise((resolve, reject) => {
        const outgoing = httpRequest(
          `${sharing.url}/probe`,
          {
            method,
            headers: { 'Transfer-Encoding': 'chunked', ...(contentType ? { 'Content-Type': contentType } : {}) },
          },
          (response) => {
            let data = '';
            response.on('data', (chunk) => {
              data += chunk;
            });
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
          },
        );
        outgoing.on('error', reject);
        outgoing.end(body);
      });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await request(method);
      assert.equal(response.status, 200, `${method}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.body, null);
      assert.equal(response.body.contentType, null);
    }
    assert.equal((await request('POST', 'untyped body')).status, 415);
    const json = await request('POST', JSON.stringify({ name: '서재' }), 'application/json');
    assert.equal(json.status, 200);
    assert.deepEqual(json.body.body, { name: '서재' });
    const bytes = Buffer.from([0, 255, 128, 1]);
    const binary = await request('PUT', bytes, 'application/octet-stream');
    assert.equal(binary.status, 200);
    assert.deepEqual(binary.body.body, [...bytes]);
  } finally {
    await sharing?.stop();
    await api.close();
  }
});
