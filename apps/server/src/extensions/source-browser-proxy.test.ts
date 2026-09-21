import { createServer } from 'node:net';
import { request, createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { openSourceBrowserProxy } from './source-browser-proxy';

it.each([
  { purpose: undefined, megabytes: 40, complete: false },
  { purpose: 'image-pages' as const, megabytes: 40, complete: true },
  { purpose: 'image-pages' as const, megabytes: 289, complete: false },
])('bounds actual browser traffic for $purpose at $megabytes MiB', async ({ purpose, megabytes, complete }) => {
  const chunk = Buffer.alloc(1024 * 1024);
  const upstream = createHttpServer((_request, response) => {
    let sent = 0;
    const pump = () => {
      while (sent < megabytes && !response.destroyed) {
        sent++;
        if (!response.write(chunk)) {
          response.once('drain', pump);
          return;
        }
      }
      response.end();
    };
    pump();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const proxy = await openSourceBrowserProxy(
    { key: 'limits', purpose, privateOrigins: [origin] },
    AbortSignal.timeout(10000),
  );
  try {
    let received = 0;
    const finished = await new Promise<boolean>((resolve) => {
      const endpoint = new URL(proxy.proxy.server);
      const req = request(
        {
          hostname: endpoint.hostname,
          port: endpoint.port,
          path: origin + '/',
          agent: false,
          signal: AbortSignal.timeout(10000),
          headers: {
            'proxy-authorization':
              'Basic ' + Buffer.from(proxy.proxy.username + ':' + proxy.proxy.password).toString('base64'),
          },
        },
        (response) => {
          response.on('data', (bytes) => {
            received += bytes.length;
          });
          response.on('end', () => resolve(true));
          response.on('error', () => resolve(false));
        },
      );
      req.on('error', () => resolve(false));
      req.end();
    });
    expect(finished).toBe(complete);
    if (complete) expect(received).toBe(megabytes * chunk.length);
    else expect(received).toBeLessThan(megabytes * chunk.length);
    expect(proxy.failure).toBe(complete ? undefined : 'source_body_limit');
  } finally {
    proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it('keeps CONNECT bytes opaque, requires internal credentials, and denies ungranted loopback', async () => {
  const echo = createServer((socket) => socket.pipe(socket));
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  const port = (echo.address() as { port: number }).port;
  const origin = `https://127.0.0.1:${port}`;
  const allowed = await openSourceBrowserProxy({ key: 'test', privateOrigins: [origin] }, AbortSignal.timeout(5000));
  const denied = await openSourceBrowserProxy({ key: 'test' }, AbortSignal.timeout(5000));
  async function send(proxy: typeof allowed, authenticated: boolean, echoBytes = false) {
    return new Promise<{ status: number; bytes?: Buffer }>((resolve, reject) => {
      const endpoint = new URL(proxy.proxy.server);
      const req = request({
        hostname: endpoint.hostname,
        port: endpoint.port,
        method: 'CONNECT',
        path: `127.0.0.1:${port}`,
        headers: authenticated
          ? {
              'proxy-authorization':
                'Basic ' + Buffer.from(proxy.proxy.username + ':' + proxy.proxy.password).toString('base64'),
            }
          : {},
        signal: AbortSignal.timeout(3000),
        agent: false,
      });
      req.on('error', reject);
      req.on('connect', (response, socket) => {
        if (!echoBytes) {
          socket.destroy();
          resolve({ status: response.statusCode! });
          return;
        }
        socket.once('data', (bytes) => {
          socket.destroy();
          resolve({ status: response.statusCode!, bytes });
        });
        socket.write(Buffer.from([22, 3, 1, 0, 4, 255, 0, 128, 1]));
      });
      req.end();
    });
  }
  try {
    expect((await send(allowed, false)).status).toBe(407);
    expect((await send(denied, true)).status).toBe(403);
    const result = await send(allowed, true, true);
    expect(result.status).toBe(200);
    expect(result.bytes).toEqual(Buffer.from([22, 3, 1, 0, 4, 255, 0, 128, 1]));
  } finally {
    allowed.close();
    denied.close();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  }
});
