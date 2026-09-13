import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), agent: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
vi.mock('./outbound-proxy.js', () => ({ pinnedProxyAgent: mocks.agent }));
import { resolveProxyAddress } from './proxy-dns';
import { compatibilityHttp } from './mangayomi/http';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agent.mockImplementation(() => ({ destroy: vi.fn() }));
  mocks.request.mockImplementation((url: URL, _options, done) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () =>
      done(
        Object.assign(
          Readable.from([
            JSON.stringify({
              Status: 0,
              Answer: url.searchParams.get('type') === '1' ? [{ type: 1, data: '93.184.216.34', TTL: 0 }] : [],
            }),
          ]),
          { statusCode: 200 },
        ),
      );
    return req;
  });
});
it('sends DNS through the selected proxy without local lookup, keeping the resolver TLS name', async () => {
  expect(await resolveProxyAddress('remote.example', 'socks5://proxy:1080', 'proxy')).toEqual([
    { address: '93.184.216.34', family: 4 },
  ]);
  expect(mocks.lookup).not.toHaveBeenCalled();
  expect(mocks.agent).toHaveBeenCalledWith(
    'socks5://proxy:1080',
    expect.objectContaining({ hostname: 'cloudflare-dns.com' }),
    '1.1.1.1',
    expect.any(AbortSignal),
  );
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
it('preserves local DNS by default and never silently falls back after proxy DNS failure', async () => {
  mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  await resolveProxyAddress('local.example', 'http://proxy:8080');
  expect(mocks.lookup).toHaveBeenCalledOnce();
  mocks.lookup.mockClear();
  mocks.request.mockImplementation(() => {
    throw new Error('offline');
  });
  await expect(resolveProxyAddress('failed.example', 'http://proxy:8080', 'proxy')).rejects.toThrow(
    'source_dns_failed',
  );
  expect(mocks.lookup).not.toHaveBeenCalled();
});
it('still rejects private addresses returned through remote DNS before requesting source content', async () => {
  mocks.request.mockImplementation((_url, _options, done) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () =>
      done(
        Object.assign(
          Readable.from([JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1', TTL: 0 }] })]),
          { statusCode: 200 },
        ),
      );
    return req;
  });
  await expect(
    compatibilityHttp(
      { url: 'https://private.example' },
      AbortSignal.timeout(1000),
      [],
      1024,
      'http://proxy:8080',
      true,
      'proxy',
    ),
  ).rejects.toThrow('source_address_denied');
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
