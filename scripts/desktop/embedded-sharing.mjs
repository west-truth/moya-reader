import { createServer, request as httpRequest } from 'node:http';
import { networkInterfaces } from 'node:os';

export function sharingInterfaces() {
  return Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter(({ address, family, internal }) => {
        if (internal || family !== 'IPv4') return false;
        const [a, b] = address.split('.').map(Number);
        return (
          a === 10 ||
          (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && b === 168) ||
          (a === 100 && b >= 64 && b <= 127) ||
          (a === 169 && b === 254)
        );
      })
      .map(({ address }) => ({ name, address })),
  );
}

/** A separate listener allows revocation without interrupting the app's loopback API. */
export async function startSharing({
  url,
  host,
  onExit = () => {},
  listInterfaces = sharingInterfaces,
  monitorIntervalMs = 5_000,
}) {
  if (!listInterfaces().some(({ address }) => address === host)) {
    throw new Error('현재 연결된 사설망 주소를 선택해 주세요.');
  }
  const listener = await createSharingListener({ url, host });
  let stopping = false;
  let stopPromise;
  let monitor;
  const stop = () =>
    (stopPromise ??= (async () => {
      stopping = true;
      clearInterval(monitor);
      await listener.stop();
    })());
  monitor = setInterval(() => {
    if (stopping || listInterfaces().some(({ address }) => address === host)) return;
    // A VPN or LAN address can disappear while the listener process is alive.
    stopping = true;
    void stop().then(
      () => onExit('선택한 네트워크 연결이 끊겼습니다. 다시 연결해 주세요.'),
      () => onExit('선택한 네트워크 연결이 끊겼습니다. 다시 연결해 주세요.'),
    );
  }, monitorIntervalMs);
  monitor.unref();
  return { ...listener, stop };
}

export async function createSharingListener({ url, host = '127.0.0.1', port = 0, publicOrigin }) {
  const status = await fetch(`${url}/api/auth/status`, { signal: AbortSignal.timeout(3000) }).then((response) => {
    if (!response.ok) throw new Error('계정 상태를 확인하지 못했습니다.');
    return response.json();
  });
  if (status.setupRequired) throw new Error('다른 기기에서 로그인할 계정을 먼저 만들어 주세요.');
  const target = new URL(url);
  const sockets = new Set();
  const upstreams = new Set();
  let origin = publicOrigin;
  let authority;
  const server = createServer((request, response) => {
    // Bound address only: reject rebinding/Host spoofing, proxy credentials and setup/recovery.
    if (request.headers.host !== authority || !request.url?.startsWith('/') || request.url.startsWith('//')) {
      response.writeHead(403).end();
      return;
    }
    if (request.headers.origin && request.headers.origin !== origin) {
      response.writeHead(403).end();
      return;
    }
    if (/^\/api\/auth\/(register|recover)(?:[/?]|$)/.test(request.url) || request.headers.authorization) {
      response.writeHead(403).end();
      return;
    }
    const headers = { ...request.headers };
    for (const key of Object.keys(headers)) {
      if (key.startsWith('x-forwarded-') || ['forwarded', 'connection', 'upgrade', 'proxy-authorization'].includes(key))
        delete headers[key];
    }
    if (origin?.startsWith('https://')) headers['x-forwarded-proto'] = 'https';
    const upstream = httpRequest(
      { hostname: target.hostname, port: target.port, path: request.url, method: request.method, headers },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
        incoming.on('error', () => response.destroy());
      },
    );
    upstreams.add(upstream);
    upstream.once('close', () => upstreams.delete(upstream));
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    response.once('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const localUrl = `http://${host}:${server.address().port}`;
  origin = publicOrigin === undefined ? localUrl : publicOrigin;
  authority = origin ? new URL(origin).host : undefined;
  return {
    url: localUrl,
    setPublicOrigin(value) {
      origin = new URL(value).origin;
      authority = new URL(origin).host;
    },
    async stop() {
      const closed = new Promise((resolve) => server.close(resolve));
      for (const upstream of upstreams) upstream.destroy();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
