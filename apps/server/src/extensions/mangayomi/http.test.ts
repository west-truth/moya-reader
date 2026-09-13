import { createServer } from 'node:http';
import { describe, it, expect } from 'vitest';
import { compatibilityHttp } from './http.js';

describe('compatibility network grant', () => {
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
