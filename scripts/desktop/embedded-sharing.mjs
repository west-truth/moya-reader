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
export async function startSharing({ url, host }) {
  if (!sharingInterfaces().some(({ address }) => address === host)) {
    throw new Error('현재 연결된 사설망 주소를 선택해 주세요.');
  }
  const status = await fetch(`${url}/api/auth/status`, { signal: AbortSignal.timeout(3000) }).then((response) => {
    if (!response.ok) throw new Error('계정 상태를 확인하지 못했습니다.');
    return response.json();
  });
  if (status.setupRequired) throw new Error('다른 기기에서 로그인할 계정을 먼저 만들어 주세요.');
  const target = new URL(url);
  const sockets = new Set();
  const upstreams = new Set();
  let authority;
  const server = createServer((request, response) => {
    // Bound address only: reject rebinding/Host spoofing, proxy credentials and setup/recovery.
    if (request.headers.host !== authority || !request.url?.startsWith('/') || request.url.startsWith('//')) {
      response.writeHead(403).end();
      return;
    }
    if (request.headers.origin && request.headers.origin !== `http://${authority}`) {
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
    server.listen(0, host, resolve);
  });
  authority = `${host}:${server.address().port}`;
  return {
    url: `http://${authority}`,
    async stop() {
      const closed = new Promise((resolve) => server.close(resolve));
      for (const upstream of upstreams) upstream.destroy();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
