import { createServer } from 'node:net';
import { request } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { openSourceBrowserProxy } from './source-browser-proxy';

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
