import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createBrowserSourceHttp } from '../src/browser-source-http.mjs';

test('browser metadata transport validates configuration without launching a browser', async () => {
  for (const options of [{ channel: '/tmp/browser' }, { timeoutMs: 0 }, { timeoutMs: Infinity }])
    assert.throws(() => createBrowserSourceHttp(options), { code: 'invalid_source_http_transport' });
  const transport = createBrowserSourceHttp();
  await assert.rejects(transport.fetchImpl('file:///private'), { code: 'source_url_rejected' });
  await assert.rejects(transport.fetchImpl('https://user:secret@source.example'), { code: 'source_url_rejected' });
  await assert.rejects(transport.fetchImpl('https://source.example', { method: 'POST' }), {
    code: 'source_request_rejected',
  });
  await assert.rejects(transport.fetchImpl('https://source.example', { headers: { 'User-Agent': 'custom' } }), {
    code: 'source_request_rejected',
  });
  await transport.dispose();
  await assert.rejects(transport.fetchImpl('https://source.example'), { code: 'server_stopping' });
});

const enabled = process.env.RUN_SOURCE_BROWSER_TESTS === '1';
test(
  'normal Chromium metadata transport against an isolated loopback server',
  {
    skip: enabled ? false : 'Opt-in: RUN_SOURCE_BROWSER_TESTS=1 and an installed Chromium browser are required.',
    timeout: 60_000,
  },
  async (t) => {
    const requests = [];
    const holds = new Map();
    const arrivals = new Map();
    const waitFor = (name) =>
      new Promise((resolve) => {
        arrivals.set(name, resolve);
      });
    const exactJson = Buffer.from('\uFEFF{ "title": "합성", "spacing": "  " }\r\n', 'utf8');
    const exactHtml = Buffer.from(
      '<!DOCTYPE html><meta charset="utf-8"><title>합성</title><script>fetch("/script")</script><img src="/image"><p>정확한  원본 &amp; bytes</p>\r\n',
      'utf8',
    );
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://loopback.invalid');
      requests.push({ path: url.pathname, cookie: request.headers.cookie });
      if (url.pathname === '/json') {
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': 'private=synthetic; Path=/',
        });
        return response.end(exactJson);
      }
      if (url.pathname === '/html') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return response.end(exactHtml);
      }
      if (url.pathname === '/redirect') {
        response.writeHead(302, { Location: '/redirect-target' });
        return response.end();
      }
      if (url.pathname === '/oversized-header') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 1024 * 1024 + 1 });
        response.flushHeaders();
        return;
      }
      if (url.pathname === '/oversized-gzip') {
        const bytes = gzipSync(Buffer.from(`"${'x'.repeat(1024 * 1024)}"`));
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Content-Length': bytes.length,
        });
        return response.end(bytes);
      }
      if (url.pathname.startsWith('/hold/')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{');
        holds.set(url.pathname, response);
        arrivals.get(url.pathname)?.();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const transport = createBrowserSourceHttp({
      channel: process.env.SOURCE_BROWSER_CHANNEL || undefined,
      timeoutMs: 5_000,
    });
    t.after(async () => {
      await transport.dispose();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    await t.test(
      'returns exact JSON/HTML bytes with scripts and subresources blocked and no shared cookies',
      async () => {
        assert.deepEqual(Buffer.from(await (await transport.fetchImpl(`${origin}/json`)).arrayBuffer()), exactJson);
        const actualHtml = Buffer.from(await (await transport.fetchImpl(`${origin}/html`)).arrayBuffer());
        assert.equal(
          actualHtml.equals(exactHtml),
          true,
          `Raw HTML bytes differ (${actualHtml.length} received, ${exactHtml.length} sent); external HTTP rewriting may be present.`,
        );
        assert.deepEqual(
          requests.map(({ path }) => path),
          ['/json', '/html'],
        );
        assert.equal(requests[1].cookie, undefined);
      },
    );
    await t.test('rejects redirects before another document request is sent', async () => {
      await assert.rejects(transport.fetchImpl(`${origin}/redirect`), { code: 'source_redirect_rejected' });
      assert.equal(
        requests.some(({ path }) => path === '/redirect-target'),
        false,
      );
    });
    await t.test('stops declared and decoded compressed responses above one MiB', async () => {
      await assert.rejects(transport.fetchImpl(`${origin}/oversized-header`), { code: 'source_response_limit' });
      await assert.rejects(transport.fetchImpl(`${origin}/oversized-gzip`), { code: 'source_response_limit' });
    });
    await t.test(
      'limits active documents to two, bounds the queue to eight and cancels queued navigation',
      async () => {
        const first = new AbortController();
        const second = new AbortController();
        const firstArrived = waitFor('/hold/one');
        const secondArrived = waitFor('/hold/two');
        const one = transport.fetchImpl(`${origin}/hold/one`, { signal: first.signal });
        const two = transport.fetchImpl(`${origin}/hold/two`, { signal: second.signal });
        const oneRejected = assert.rejects(one, { name: 'AbortError' });
        const twoRejected = assert.rejects(two, { name: 'AbortError' });
        await Promise.all([firstArrived, secondArrived]);
        const queued = Array.from({ length: 8 }, () => new AbortController());
        const rejected = queued.map((controller, index) =>
          assert.rejects(transport.fetchImpl(`${origin}/hold/queued${index}`, { signal: controller.signal }), {
            name: 'AbortError',
          }),
        );
        await assert.rejects(transport.fetchImpl(`${origin}/hold/overflow`), { code: 'source_busy' });
        for (const controller of queued) controller.abort();
        await Promise.all(rejected);
        assert.equal(
          requests.some(({ path }) => path.startsWith('/hold/queued') || path === '/hold/overflow'),
          false,
        );
        first.abort();
        second.abort();
        await Promise.all([oneRejected, twoRejected]);
        // Released slots remain usable after aborting in-flight contexts.
        assert.equal((await transport.fetchImpl(`${origin}/json`)).status, 200);
      },
    );
    await t.test('includes waiting time in the request deadline', async () => {
      const queuedTransport = createBrowserSourceHttp({
        channel: process.env.SOURCE_BROWSER_CHANNEL || undefined,
        timeoutMs: 1_000,
      });
      try {
        // All deadlines start before the shared browser launch and slot acquisition.
        const results = await Promise.allSettled(
          [1, 2, 3].map((id) => queuedTransport.fetchImpl(`${origin}/hold/deadline${id}`)),
        );
        for (const result of results) {
          assert.equal(result.status, 'rejected');
          assert.equal(result.reason.code, 'source_timeout');
        }
        assert.equal(
          requests.some(({ path }) => path === '/hold/deadline3'),
          false,
        );
      } finally {
        await queuedTransport.dispose();
      }
    });
    await t.test('dispose aborts active work and prevents any later browser launch', async () => {
      const arrived = waitFor('/hold/dispose');
      const pending = transport.fetchImpl(`${origin}/hold/dispose`);
      const rejected = assert.rejects(pending, { code: 'server_stopping' });
      await arrived;
      await transport.dispose();
      await rejected;
      await assert.rejects(transport.fetchImpl(`${origin}/json`), { code: 'server_stopping' });
    });
  },
);
