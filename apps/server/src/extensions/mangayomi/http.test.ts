import { createServer } from 'node:http';
import { describe, it, expect } from 'vitest';
import { compatibilityHttp } from './http.js';

describe('compatibility network grant', () => {
  it('falls back from unreachable IPv6 to IPv4 using one validated DNS answer', async () => {
    let lookups = 0;
    const server = createServer((req, res) => {
      expect(req.headers.host).toMatch(/^dual\.test:/);
      res.setHeader('Content-Type', 'image/png');
      res.end('image');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listen');
    const origin = `http://dual.test:${address.port}`;
    try {
      const result = await compatibilityHttp(
        { url: origin + '/cover.png' },
        new AbortController().signal,
        [origin],
        1024,
        undefined,
        true,
        async () => {
          lookups++;
          return [
            { address: '::1', family: 6 },
            { address: '127.0.0.1', family: 4 },
          ];
        },
      );
      expect(result.bytes.toString()).toBe('image');
      expect(lookups).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not replay POST on another resolved address after a transport reset', async () => {
    let requests = 0;
    let lookups = 0;
    const server = createServer((req) => {
      req.resume();
      req.once('end', () => {
        requests++;
        req.socket.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listen');
    const origin = `http://post.test:${address.port}`;
    try {
      await expect(
        compatibilityHttp(
          { url: origin + '/jobs', method: 'POST', body: '{}' },
          new AbortController().signal,
          [origin],
          1024,
          undefined,
          true,
          async () => {
            lookups++;
            return [
              { address: '127.0.0.1', family: 4 },
              { address: '127.0.0.1', family: 4 },
            ];
          },
        ),
      ).rejects.toThrow('source_connection_failed');
      expect(lookups).toBe(1);
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('revalidates redirected DNS answers and rejects one denied address before connecting', async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.statusCode = 302;
      res.setHeader('Location', 'http://redirected.test/cover.png');
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listen');
    const origin = `http://original.test:${address.port}`;
    const hosts: string[] = [];
    try {
      await expect(
        compatibilityHttp(
          { url: origin + '/redirect' },
          new AbortController().signal,
          [origin],
          1024,
          undefined,
          true,
          async (host) => {
            hosts.push(host);
            return host === 'original.test'
              ? [{ address: '127.0.0.1', family: 4 }]
              : [
                  { address: '93.184.216.34', family: 4 },
                  { address: '127.0.0.1', family: 4 },
                ];
          },
        ),
      ).rejects.toThrow('source_address_denied');
      expect(hosts).toEqual(['original.test', 'redirected.test']);
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not try another resolved address after caller cancellation', async () => {
    let requests = 0;
    const server = createServer((_req, _res) => {
      requests++;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listen');
    const origin = `http://cancel.test:${address.port}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25);
    try {
      await expect(
        compatibilityHttp({ url: origin + '/hang' }, controller.signal, [origin], 1024, undefined, true, async () => [
          { address: '127.0.0.1', family: 4 },
          { address: '::1', family: 6 },
        ]),
      ).rejects.toThrow('cancelled');
      expect(requests).toBe(1);
    } finally {
      clearTimeout(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('recovers one dropped GET, bounds persistent failures and does not replay POST jobs', async () => {
    const counts = new Map<string, number>();
    const server = createServer((req, res) => {
      const key = `${req.method ?? 'GET'}${req.url ?? '/'}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (req.url === '/recover' && count === 2) res.end('ok');
      else req.socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listen');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const result = await compatibilityHttp({ url: origin + '/recover' }, new AbortController().signal, [origin]);
      expect(result.bytes.toString()).toBe('ok');
      expect(counts.get('GET/recover')).toBe(2);
      await expect(
        compatibilityHttp({ url: origin + '/fail' }, new AbortController().signal, [origin]),
      ).rejects.toThrow('source_connection_failed');
      expect(counts.get('GET/fail')).toBe(2);
      await expect(
        compatibilityHttp({ url: origin + '/jobs', method: 'POST', body: '{}' }, new AbortController().signal, [
          origin,
        ]),
      ).rejects.toThrow('source_connection_failed');
      expect(counts.get('POST/jobs')).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('denies implicit private access and permits only an owner-approved origin', async () => {
    const server = createServer((req, res) => {
      expect(req.headers.authorization).toBe('Bearer fixture');
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listen');
    const origin = `http://127.0.0.1:${address.port}`,
      signal = new AbortController().signal;
    try {
      await expect(compatibilityHttp({ url: origin + '/jobs' }, signal)).rejects.toThrow('source_address_denied');
      const response = await compatibilityHttp(
        { url: origin + '/jobs', headers: { Authorization: 'Bearer fixture' } },
        signal,
        [origin],
      );
      expect(response.bytes.toString()).toBe('{"ok":true}');
      await expect(compatibilityHttp({ url: origin + '/jobs' }, signal, ['http://127.0.0.1:1'])).rejects.toThrow(
        'source_address_denied',
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
