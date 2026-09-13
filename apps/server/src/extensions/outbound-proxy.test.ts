import { createServer, request } from 'node:http';
import { createServer as createTcpServer, connect, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { parseOutboundProxy, pinnedProxyAgent } from './outbound-proxy.js';

describe('owner-selected outbound proxy', () => {
  it('accepts optional HTTP/SOCKS5 addresses and rejects credentials, paths and unsupported schemes', () => {
    expect(parseOutboundProxy('')).toBeUndefined();
    expect(parseOutboundProxy('socks5://127.0.0.1:40000')).toBe('socks5://127.0.0.1:40000');
    for (const url of [
      'file:///tmp/a',
      'http://user:pass@localhost:40000',
      'https://localhost/path',
      'http://localhost:0',
      'http://localhost/#x',
    ])
      expect(() => parseOutboundProxy(url)).toThrow('compatibility_preferences_invalid');
  });
  it('CONNECT pins the approved IP while preserving the destination Host header', async () => {
    const target = createServer((req, res) => {
      expect(req.headers.host).toBe('fixture.invalid:1234');
      res.end('image');
    });
    const sockets = new Set<Socket>();
    const proxy = createServer();
    let destination = '';
    const track = (socket: Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    };
    proxy.on('connection', track);
    target.on('connection', track);
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetPort = (target.address() as import('node:net').AddressInfo).port;
    proxy.on('connect', (req, downstream, head) => {
      destination = req.url!;
      const upstream = connect(targetPort, '127.0.0.1', () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        downstream.pipe(upstream).pipe(downstream);
      });
      track(upstream);
      downstream.on('close', () => upstream.destroy());
      upstream.on('error', () => downstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const agent = pinnedProxyAgent(
      `http://127.0.0.1:${(proxy.address() as import('node:net').AddressInfo).port}`,
      new URL('http://fixture.invalid:1234'),
      '127.0.0.1',
      new AbortController().signal,
    )!;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = request('http://fixture.invalid:1234/a', { agent }, (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve(text));
        });
        req.on('error', reject);
        req.end();
      });
      expect(destination).toBe('127.0.0.1:1234');
      expect(body).toBe('image');
    } finally {
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => target.close(() => resolve())),
      ]);
    }
  });
  it.each(['http', 'socks5'])('aborts a stalled %s proxy handshake', async (scheme) => {
    const sockets = new Set<Socket>();
    const proxy = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const abort = new AbortController();
    const agent = pinnedProxyAgent(
      `${scheme}://127.0.0.1:${(proxy.address() as import('node:net').AddressInfo).port}`,
      new URL('http://example.com'),
      '93.184.215.14',
      abort.signal,
    )!;
    try {
      const promise = new Promise((resolve, reject) => {
        const req = request('http://example.com', { agent, signal: abort.signal }, resolve);
        req.on('error', reject);
        req.end();
      });
      const timer = setTimeout(() => abort.abort(), 30);
      try {
        await expect(promise).rejects.toThrow();
      } finally {
        clearTimeout(timer);
      }
    } finally {
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
  it('SOCKS5 tunnels to the approved IP and carries the original HTTP request', async () => {
    let destination = '';
    const sockets = new Set<Socket>();
    const proxy = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let phase = 0,
        buffered = Buffer.alloc(0);
      socket.on('data', (data) => {
        buffered = Buffer.concat([buffered, data]);
        if (phase === 0 && buffered.length >= 3) {
          expect([...buffered.subarray(0, 3)]).toEqual([5, 1, 0]);
          buffered = buffered.subarray(3);
          phase = 1;
          socket.write(Buffer.from([5, 0]));
        }
        if (phase === 1 && buffered.length >= 10) {
          expect([...buffered.subarray(0, 4)]).toEqual([5, 1, 0, 1]);
          destination = [...buffered.subarray(4, 8)].join('.') + ':' + buffered.readUInt16BE(8);
          buffered = buffered.subarray(10);
          phase = 2;
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        }
        if (phase === 2 && buffered.includes('\r\n\r\n')) {
          expect(buffered.toString()).toContain('Host: fixture.invalid:8080');
          phase = 3;
          socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
        }
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const agent = pinnedProxyAgent(
      `socks5://127.0.0.1:${(proxy.address() as import('node:net').AddressInfo).port}`,
      new URL('http://fixture.invalid:8080'),
      '93.184.215.14',
      new AbortController().signal,
    )!;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = request('http://fixture.invalid:8080', { agent }, (res) => {
          let text = '';
          res.on('data', (data) => (text += data));
          res.on('end', () => resolve(text));
        });
        req.on('error', reject);
        req.end();
      });
      expect(body).toBe('ok');
      expect(destination).toBe('93.184.215.14:8080');
    } finally {
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
