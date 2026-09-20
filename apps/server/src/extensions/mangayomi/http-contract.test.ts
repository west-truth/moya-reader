import { createServer } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { compatibilityHttp } from './http.js';
import { invokeMangayomi } from './runtime.js';
import { fixtureRow } from './test-fixture.js';
import { parseMangayomiIndex } from '../../../../../packages/extension-contracts/compatibility-repository.js';
import { sourceBrowserHttp } from '../source-browser-cookies.js';
import { compatibilityHttpPolicy } from './http-options.js';

let origin: string;
let received: { method?: string; cookie?: string; body: string; url?: string }[];
let stalledClosed: Promise<void>;
let closeStalled: () => void;
let server: ReturnType<typeof createServer>;
beforeEach(async () => {
  received = [];
  stalledClosed = new Promise((resolve) => {
    closeStalled = resolve;
  });
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const part of request) chunks.push(Buffer.from(part));
    received.push({
      method: request.method,
      cookie: request.headers.cookie,
      body: Buffer.concat(chunks).toString(),
      url: request.url,
    });
    if (request.url === '/stall') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"pending":');
      response.on('close', () => closeStalled());
    } else if (request.url === '/start') {
      response.writeHead(302, { location: '/end', 'set-cookie': 'session=secret; Path=/' });
      response.end();
    } else if (request.url === '/loop') {
      response.writeHead(302, { location: '/loop' });
      response.end();
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('listen');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
function cookieTransport() {
  let secret: string | undefined;
  const scope = {
    key: 'test',
    privateOrigins: [origin],
    vault: {
      read: () => (secret ? { secret } : undefined),
      write: (_key: string, value?: { secret: string }) => {
        secret = value?.secret;
      },
    },
  };
  return ((input, signal, _origins, maximum) =>
    sourceBrowserHttp(
      input,
      signal,
      scope,
      maximum ?? 768 * 1024,
      compatibilityHttp,
      true,
    )) as typeof compatibilityHttp;
}
function invoke(expression: string, transport = cookieTransport()) {
  return invokeMangayomi(
    {
      entry: parseMangayomiIndex([fixtureRow])[0],
      signal: AbortSignal.timeout(5000),
      action: 'detail',
      source: `class DefaultExtension extends MProvider {async getDetail(){return ${expression};}}`,
      privateOrigins: [origin],
    },
    transport,
  );
}

it('sends PATCH and exposes source request metadata without leaking session headers', async () => {
  const transport = cookieTransport();
  await invoke(`new Client().get('${origin}/start')`, transport);
  expect(received[1].cookie).toBe('session=secret');
  const { result } = await invoke(
    `new Client().patch('${origin}/end',{'Content-Type':'application/json'},{name:'테스트'})`,
    transport,
  );
  expect(received.at(-1)).toMatchObject({ method: 'PATCH', body: '{"name":"테스트"}', cookie: 'session=secret' });
  expect(result).toMatchObject({
    statusCode: 200,
    isRedirect: false,
    body: '{"ok":true}',
    request: {
      url: origin + '/end',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      contentLength: Buffer.byteLength('{"name":"테스트"}'),
      followRedirects: true,
      maxRedirects: 4,
    },
  });
  expect((result as { request: { headers: unknown } }).request.headers).not.toHaveProperty('cookie');
});

it('honors no-follow through the installed host cookie transport', async () => {
  const { result } = await invoke(`new Client({followRedirects:false}).get('${origin}/start')`);
  expect(received.map((row) => row.url)).toEqual(['/start']);
  expect(result).toMatchObject({
    statusCode: 302,
    isRedirect: true,
    headers: { location: '/end' },
    request: { followRedirects: false },
  });
});

it('applies redirect limits in both direct and session transports', async () => {
  for (const transport of [compatibilityHttp, cookieTransport()]) {
    received = [];
    await expect(
      transport({ url: origin + '/loop', options: { maxRedirects: 1 } }, AbortSignal.timeout(3000), [origin]),
    ).rejects.toThrow('source_redirect_limit');
    expect(received).toHaveLength(2);
  }
});

it('aborts a real response that stalls after headers using the Client timeout', async () => {
  await expect(invoke(`new Client({timeout:0.15}).get('${origin}/stall')`)).rejects.toThrow('source_request_timeout');
  await stalledClosed;
  expect(received).toHaveLength(1);
});

it('also bounds DNS resolution and never starts a connection after timeout', async () => {
  await expect(
    compatibilityHttp(
      { url: 'https://pending.example/', options: { timeout: 0.02 } },
      AbortSignal.timeout(2000),
      [],
      1024,
      undefined,
      true,
      async () => new Promise(() => {}),
    ),
  ).rejects.toThrow('source_request_timeout');
  expect(received).toHaveLength(0);
});

it('rejects malformed options and caps host budgets without changing TLS or network grants', async () => {
  expect(compatibilityHttpPolicy({ timeout: 1e10, maxRedirects: 999 })).toEqual({
    timeoutMs: 90000,
    maxRedirects: 4,
    followRedirects: true,
  });
  for (const options of [{ timeout: -1 }, { timeout: Infinity }, { followRedirects: 'yes' }, { maxRedirects: 0.5 }]) {
    await expect(invoke(`new Client(${JSON.stringify(options)}).get('${origin}/end')`)).rejects.toThrow();
  }
  expect(received).toEqual([]);
  await expect(compatibilityHttp({ url: origin, options: { timeout: 1 } }, AbortSignal.timeout(3000))).rejects.toThrow(
    'source_address_denied',
  );
});
