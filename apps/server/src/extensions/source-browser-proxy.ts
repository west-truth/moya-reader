import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { SocksClient } from 'socks';
import { isPublicSourceAddress } from '@moya/extension-runtime/source-http';
import { parseOutboundProxy } from './outbound-proxy.js';
import type { SourceWebViewScope } from './source-webview.js';

/** CONNECT transports opaque browser TLS bytes: no origin TLS termination or Node impersonation. */
async function tunnel(address: string, port: number, proxy: string | undefined, signal: AbortSignal): Promise<Socket> {
  const parsed = parseOutboundProxy(proxy);
  if (parsed?.startsWith('socks5:')) {
    const url = new URL(parsed);
    const socket = connect({ host: url.hostname, port: Number(url.port || 1080), signal });
    try {
      await once(socket, 'connect', { signal });
      await SocksClient.createConnection({
        command: 'connect',
        proxy: { host: url.hostname, port: Number(url.port || 1080), type: 5 },
        destination: { host: address, port },
        existing_socket: socket,
        timeout: 15000,
      });
      signal.throwIfAborted();
      return socket;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }
  if (parsed) {
    const url = new URL(parsed);
    return new Promise((resolve, reject) => {
      const authority = `${isIP(address) === 6 ? '[' + address + ']' : address}:${port}`;
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
        hostname: url.hostname,
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
        method: 'CONNECT',
        path: authority,
        headers: { host: authority },
        agent: false,
        signal,
      });
      request.once('error', reject);
      request.once('connect', (response, socket, head) => {
        if (response.statusCode !== 200 || signal.aborted) {
          socket.destroy();
          reject(new Error('source_connection_failed'));
          return;
        }
        if (head.length) socket.unshift(head);
        resolve(socket);
      });
      request.end();
    });
  }
  const socket = connect({ host: address, port, signal });
  try {
    await once(socket, 'connect', { signal });
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export async function openSourceBrowserProxy(scope: SourceWebViewScope, signal: AbortSignal) {
  const username = randomBytes(16).toString('hex'),
    password = randomBytes(24).toString('hex');
  const authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  const sockets = new Set<Duplex>();
  let total = 0,
    connections = 0,
    failure: string | undefined;
  const fail = (error: unknown) => {
    failure = /^source_[a-z_]+$/.test((error as Error).message) ? (error as Error).message : 'source_connection_failed';
  };
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      total += chunk.length;
      if (total > 32 * 1024 * 1024) {
        failure = 'source_body_limit';
        for (const open of sockets) open.destroy();
      }
    });
    return socket;
  };
  const target = async (raw: string) => {
    signal.throwIfAborted();
    const url = new URL(raw);
    const local = scope.privateOrigins?.includes(url.origin);
    if (
      url.username ||
      url.password ||
      url.hash ||
      !['https:', 'http:'].includes(url.protocol) ||
      (scope.origins && !scope.origins.includes(url.origin) && !local) ||
      (url.protocol === 'http:' && !local)
    )
      throw new Error('source_url_denied');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true, verbatim: true });
    signal.throwIfAborted();
    if (!addresses.length || (!local && addresses.some((row) => !isPublicSourceAddress(row.address))))
      throw new Error('source_address_denied');
    return {
      url,
      address: addresses[0],
      proxy: local && !isPublicSourceAddress(addresses[0].address) ? undefined : scope.outboundProxy,
    };
  };
  const server = createServer(async (request, response) => {
    if (request.headers['proxy-authorization'] !== authorization) {
      response.writeHead(407, { 'proxy-authenticate': 'Basic realm="source"' }).end();
      return;
    }
    try {
      const { url, address, proxy } = await target(request.url ?? '');
      if (url.protocol !== 'http:' || proxy || ++connections > 512) throw new Error('source_url_denied');
      const headers: import('node:http').IncomingHttpHeaders = { ...request.headers, host: url.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = httpRequest(
        url,
        {
          method: request.method,
          headers,
          signal,
          agent: false,
          lookup: (_host, options, callback) =>
            options.all ? callback(null, [address]) : callback(null, address.address, address.family),
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.on('error', () => response.destroy());
          incoming.pipe(response);
        },
      );
      upstream.on('socket', track);
      upstream.on('error', (error) => {
        fail(error);
        response.destroy();
      });
      response.once('close', () => upstream.destroy());
      request.pipe(upstream);
    } catch (error) {
      fail(error);
      response.writeHead(403).end();
    }
  });
  server.on('connection', (socket) => {
    if (sockets.size >= 64 || signal.aborted) {
      socket.destroy();
      return;
    }
    track(socket);
  });
  server.on('connect', (request, client, head) => {
    if (request.headers['proxy-authorization'] !== authorization) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="source"\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    void (async () => {
      try {
        if (++connections > 512 || !request.url || /[/@?#]/.test(request.url)) throw new Error('source_url_denied');
        const { url, address, proxy } = await target('https://' + request.url);
        const remote = await tunnel(address.address, Number(url.port || 443), proxy, signal);
        if (client.destroyed || signal.aborted) {
          remote.destroy();
          return;
        }
        track(remote);
        client.once('close', () => remote.destroy());
        remote.once('close', () => client.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) remote.write(head);
        client.pipe(remote);
        remote.pipe(client);
      } catch (error) {
        fail(error);
        client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      }
    })();
  });
  const close = () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening', { signal });
  } catch (error) {
    close();
    signal.removeEventListener('abort', close);
    throw error;
  }
  return {
    proxy: {
      server: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      username,
      password,
      bypass: '<-loopback>',
    },
    get failure() {
      return failure;
    },
    close() {
      signal.removeEventListener('abort', close);
      close();
    },
  };
}
