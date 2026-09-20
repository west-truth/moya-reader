import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { approveSourceUrl, createSourceHttp, isPublicSourceAddress } from '../source-http.mjs';
import { createSourceBroker } from '../source-broker.mjs';
import { runExtension } from '../host.mjs';
import { MAX_SOURCE_TEXT_BYTES } from '../content-limits.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('a pinned HTTPS connection failure rejects without an unhandled TLS socket error', async () => {
  // Real TLS construction in a child: the old synchronous lookup crashed outside Promise.catch.
  const moduleUrl = new URL('../source-http.mjs', import.meta.url).href;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { createSourceHttp } from ${JSON.stringify(moduleUrl)};
    const http = createSourceHttp(['https://probe.invalid:1'], {
      lookup: async () => [{address:'2606:4700:4700::1111',family:6}]
    });
    try { await http({url:'https://probe.invalid:1/',response:'text'},AbortSignal.timeout(700)); }
    catch(error) { console.log(error.message); }
  `,
    ],
    { timeout: 4000 },
  );
  assert.match(stdout, /source_connection_failed|source_request_timeout|cancelled/);
});

const origins = ['https://catalog.example'];
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const response = (text, headers = {}) => ({ status: 200, headers, body: Readable.from([Buffer.from(text)]) });
const signal = () => new AbortController().signal;

test('origin and public-address policy rejects internal, metadata and transition networks', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
    'fe80::1',
    '2002:7f00:1::',
  ])
    assert.equal(isPublicSourceAddress(address), false, address);
  assert.equal(isPublicSourceAddress('93.184.216.34'), true);
  assert.equal(isPublicSourceAddress('2606:4700:4700::1111'), true);
  await assert.rejects(approveSourceUrl('https://other.example', origins, lookup));
  await assert.rejects(approveSourceUrl(origins[0], origins, async () => [{ address: '127.0.0.1', family: 4 }]));
  await assert.rejects(
    approveSourceUrl(origins[0], origins, async () => [...(await lookup()), { address: '10.0.0.1', family: 4 }]),
  );
});

test('redirect destinations are checked again and callers cannot inject authentication headers', async () => {
  let requests = 0;
  const http = createSourceHttp(origins, {
    lookup,
    transport: async () => {
      requests++;
      return { status: 302, headers: { location: 'http://169.254.169.254/' }, body: Readable.from([]) };
    },
  });
  await assert.rejects(http({ url: origins[0], response: 'text' }, signal()));
  assert.equal(requests, 1);
  await assert.rejects(http({ url: origins[0], response: 'text', headers: { authorization: 'secret' } }, signal()));
  assert.equal(requests, 1);
});

test('different text/image fixtures run through guest JSON calls while raw source bytes stay in the host', async () => {
  const raw = Buffer.from('첫 줄\r\n둘째 줄\n\n', 'utf8');
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
  const broker = createSourceBroker(
    { origins, allowDownloads: true },
    {
      lookup,
      transport: async ({ url }) =>
        url.pathname === '/image'
          ? response(image, { 'content-type': 'image/png' })
          : response(raw, { 'content-type': 'text/plain' }),
    },
  );
  try {
    const source = `globalThis.moyaExtension=async (method,input,host)=>host.request('http.request',{url:input.url,response:'asset'});`;
    for (const [path, bytes] of [
      ['/text', raw],
      ['/image', image],
    ]) {
      const result = await runExtension({
        source,
        method: 'download',
        input: { url: origins[0] + path },
        broker: broker.methods,
      });
      assert.equal(result.byteLength, bytes.length);
      assert.deepEqual(broker.takeAsset(result.handle).bytes, bytes);
      assert.throws(() => broker.takeAsset(result.handle));
    }
  } finally {
    broker.dispose();
  }
});

test('assets are invocation scoped and body limits apply with and without content-length', async () => {
  for (const headers of [{ 'content-length': '9999999' }, {}]) {
    const broker = createSourceBroker(
      { origins },
      { lookup, transport: async () => response('x'.repeat(MAX_SOURCE_TEXT_BYTES + 1), headers) },
    );
    await assert.rejects(broker.methods['http.request']({ url: origins[0], response: 'text' }, signal()));
    await assert.rejects(broker.methods['http.request']({ url: origins[0], response: 'asset' }, signal()));
    broker.dispose();
  }
  const a = createSourceBroker({ origins, allowDownloads: true });
  const b = createSourceBroker({ origins, allowDownloads: true });
  const asset = await a.methods['asset.fromText']({ text: '원문' }, signal());
  assert.throws(() => b.takeAsset(asset.handle));
  a.dispose();
  b.dispose();
  assert.throws(() => a.takeAsset(asset.handle));
});

test('cancellation during a body read destroys the stream and releases the request', async () => {
  const controller = new AbortController();
  const body = new Readable({
    read() {
      this.push(Buffer.from('part'));
      this._read = () => {};
      controller.abort();
    },
  });
  const broker = createSourceBroker(
    { origins },
    { lookup, transport: async () => ({ status: 200, headers: {}, body }) },
  );
  await assert.rejects(broker.methods['http.request']({ url: origins[0], response: 'text' }, controller.signal));
  assert.equal(body.destroyed, true);
  broker.dispose();
});

test('ordinary access denial survives the guest boundary without claiming login is required', async () => {
  const broker = createSourceBroker(
    { origins },
    { lookup, transport: async () => ({ status: 401, headers: {}, body: Readable.from(['private upstream body']) }) },
  );
  try {
    await assert.rejects(
      runExtension({
        source: `globalThis.moyaExtension=(_,input,host)=>host.request('http.request',{url:input.url,response:'text'});`,
        method: 'list',
        input: { url: origins[0] },
        broker: broker.methods,
      }),
      { code: 'source_access_denied' },
    );
  } finally {
    broker.dispose();
  }
});

test('TLS certificate failures cross the guest boundary without exposing certificate details', async () => {
  const broker = createSourceBroker(
    { origins, allowDownloads: true },
    {
      lookup,
      transport: async () => {
        throw Object.assign(new Error('expired certificate for private hostname'), { code: 'CERT_HAS_EXPIRED' });
      },
    },
  );
  try {
    await assert.rejects(
      runExtension({
        source: `globalThis.moyaExtension=(_,input,host)=>host.request('http.request',{url:input.url,response:'asset'});`,
        method: 'cover',
        input: { url: origins[0] },
        broker: broker.methods,
      }),
      { code: 'source_tls_failed' },
    );
  } finally {
    broker.dispose();
  }
});

test('HTTP denials require explicit authentication context before being classified as account errors', async () => {
  for (const status of [401, 403]) {
    for (const authenticated of [false, true]) {
      const http = createSourceHttp(origins, {
        lookup,
        authenticate: async () => ({ authorization: 'Bearer fixture' }),
        transport: async () => ({ status, headers: {}, body: Readable.from(['denied']) }),
      });
      await assert.rejects(http({ url: origins[0], response: 'text', authenticated }, signal()), {
        message: authenticated
          ? status === 401
            ? 'source_auth_required'
            : 'source_auth_forbidden'
          : 'source_access_denied',
      });
    }
  }
});

test('large text crosses HTTP and asset RPC boundaries without changing source bytes', async () => {
  const raw = Buffer.from('\uFEFF<p title="본문">긴 회차\r\n</p>'.repeat(40000));
  assert.ok(raw.length > 1024 * 1024 && raw.length < MAX_SOURCE_TEXT_BYTES);
  const broker = createSourceBroker(
    { origins, allowDownloads: true },
    {
      lookup,
      transport: async () => response(raw, { 'content-length': String(raw.length) }),
    },
  );
  try {
    const result = await runExtension({
      source: `globalThis.moyaExtension=async (_,input,host)=>{
        const {text}=await host.request('http.request',{url:input.url,response:'text'});
        return host.request('asset.fromText',{text});
      };`,
      method: 'download',
      input: { url: origins[0] },
      broker: broker.methods,
      timeoutMs: 10000,
    });
    // HTTP text decoding removes an initial UTF-8 BOM; all subsequent source bytes are preserved.
    assert.deepEqual(broker.takeAsset(result.handle).bytes, raw.subarray(3));
    await assert.rejects(
      broker.methods['asset.fromText']({ text: 'x'.repeat(MAX_SOURCE_TEXT_BYTES + 1) }, signal()),
      /source_body_limit/,
    );
  } finally {
    broker.dispose();
  }
});

test('a transient GET connection failure retries once with fresh address approval', async () => {
  let calls = 0;
  let lookups = 0;
  const http = createSourceHttp(origins, {
    lookup: async () => {
      lookups++;
      return lookup();
    },
    transport: async () => {
      if (++calls === 1) throw Object.assign(new Error('private transport detail'), { code: 'ECONNRESET' });
      return response('ok');
    },
  });
  const result = await http({ url: origins[0], response: 'text' }, signal());
  result.body.destroy();
  assert.equal(calls, 2);
  assert.equal(lookups, 2);
});

test('a pinned request falls back from unreachable IPv6 to IPv4 without another DNS lookup', async () => {
  let lookups = 0;
  const attempts = [];
  const addresses = [
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '93.184.216.34', family: 4 },
  ];
  const http = createSourceHttp(origins, {
    lookup: async () => {
      lookups++;
      return addresses;
    },
    transport: async (approved) => {
      attempts.push(approved.address);
      if (approved.address.family === 6) throw Object.assign(new Error('unreachable'), { code: 'ENETUNREACH' });
      return response('ok');
    },
  });
  const result = await http({ url: origins[0], response: 'text' }, signal());
  result.body.destroy();
  assert.equal(lookups, 1);
  assert.deepEqual(attempts, addresses);
});

test('a POST transport failure never falls back to another resolved address', async () => {
  let lookups = 0;
  let attempts = 0;
  const http = createSourceHttp(origins, {
    lookup: async () => {
      lookups++;
      return [
        { address: '2606:4700:4700::1111', family: 6 },
        { address: '93.184.216.34', family: 4 },
      ];
    },
    transport: async () => {
      attempts++;
      throw Object.assign(new Error('reset after request write'), { code: 'ECONNRESET' });
    },
  });
  await assert.rejects(
    http({ url: origins[0], method: 'POST', body: '{}', response: 'text' }, signal()),
    /source_connection_failed/,
  );
  assert.equal(lookups, 1);
  assert.equal(attempts, 1);
});

test('address fallback validates the complete DNS answer before connecting', async () => {
  let requests = 0;
  const http = createSourceHttp(origins, {
    lookup: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
    transport: async () => {
      requests++;
      return response('unsafe');
    },
  });
  await assert.rejects(http({ url: origins[0], response: 'text' }, signal()), /source_address_denied/);
  assert.equal(requests, 0);
});

test('redirects resolve and validate their own complete address set', async () => {
  const redirectedOrigins = ['https://catalog.example', 'https://images.example'];
  const lookups = [];
  let requests = 0;
  const http = createSourceHttp(redirectedOrigins, {
    lookup: async (host) => {
      lookups.push(host);
      return host === 'catalog.example'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [
            { address: '93.184.216.35', family: 4 },
            { address: '127.0.0.1', family: 4 },
          ];
    },
    transport: async () => {
      requests++;
      return {
        status: 302,
        headers: { location: 'https://images.example/cover.png' },
        body: Readable.from([]),
      };
    },
  });
  await assert.rejects(http({ url: redirectedOrigins[0], response: 'asset' }, signal()), /source_address_denied/);
  assert.deepEqual(lookups, ['catalog.example', 'images.example']);
  assert.equal(requests, 1);
});

test('deadline cancellation stops address fallback and TLS failures stay specific', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const http = createSourceHttp(origins, {
    lookup: async () => [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ],
    transport: async () => {
      attempts++;
      controller.abort();
      throw Object.assign(new Error('unreachable'), { code: 'ENETUNREACH' });
    },
  });
  await assert.rejects(http({ url: origins[0], response: 'asset' }, controller.signal), /cancelled/);
  assert.equal(attempts, 1);

  const tls = createSourceHttp(origins, {
    lookup,
    transport: async () => {
      throw Object.assign(new Error('certificate detail'), { code: 'CERT_HAS_EXPIRED' });
    },
  });
  await assert.rejects(tls({ url: origins[0], response: 'asset' }, signal()), /source_tls_failed/);
});

test('connection retries are bounded and never replay POST or HTTP denial', async () => {
  for (const method of ['GET', 'POST']) {
    let calls = 0;
    const http = createSourceHttp(origins, {
      lookup,
      transport: async () => {
        calls++;
        throw Object.assign(new Error('private transport detail'), { code: 'ECONNRESET' });
      },
    });
    await assert.rejects(http({ url: origins[0], method, response: 'text' }, signal()), /source_connection_failed/);
    assert.equal(calls, method === 'GET' ? 2 : 1);
  }
  for (const status of [401, 403, 429, 503]) {
    let calls = 0;
    const body = Readable.from(['denied']);
    const http = createSourceHttp(origins, {
      lookup,
      transport: async () => {
        calls++;
        return { status, headers: {}, body };
      },
    });
    await assert.rejects(http({ url: origins[0], response: 'text' }, signal()));
    assert.equal(calls, 1);
    assert.equal(body.destroyed, true);
  }
});

test('cancellation interrupts the retry delay without another network request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const http = createSourceHttp(origins, {
    lookup,
    transport: async () => {
      calls++;
      setTimeout(() => controller.abort(), 20);
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    },
  });
  await assert.rejects(http({ url: origins[0], response: 'text' }, controller.signal), /cancelled/);
  assert.equal(calls, 1);
});
