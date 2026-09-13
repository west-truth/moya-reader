import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { approveSourceUrl, createSourceHttp, isPublicSourceAddress } from '../source-http.mjs';
import { createSourceBroker } from '../source-broker.mjs';
import { runExtension } from '../host.mjs';
import { MAX_SOURCE_TEXT_BYTES } from '../content-limits.mjs';

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

test('authentication failure survives the guest boundary as a safe code, never a raw response', async () => {
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
      { code: 'source_auth_required' },
    );
  } finally {
    broker.dispose();
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
