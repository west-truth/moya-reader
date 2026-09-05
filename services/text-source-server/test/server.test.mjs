import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTextSourceServer } from '../src/server.mjs';
import { createContentJobProvider } from '../src/content-job-provider.mjs';
import { createConfiguredSources } from '../src/source-configuration.mjs';
import { MAX_CONTENT_BYTES } from '../src/catalog.mjs';

const KEY = 'synthetic-server-key-1234';
const ORIGIN = 'https://moya.example';
const JOB_ID = '12345678-1234-1234-1234-123456789abc';
const CHAPTER_URL = 'https://source.example/novel/work/1';
const authorization = { Authorization: `Bearer ${KEY}` };

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moya-text-source-test-'));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith('moya-text-source-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const content = path.join(root, 'content');
  await mkdir(content);
  return { root, content, catalogFile: path.join(root, 'catalog.json') };
}

function catalog(releases) {
  return {
    instanceId: 'fixture-instance',
    dataNamespace: 'fixture-data',
    sources: [
      {
        id: 'fixture',
        name: 'Fixture source',
        works: [
          { id: 'work', title: 'Fixture work', author: 'Fixture author', releases },
          { id: 'other', title: 'Other work', releases: [] },
        ],
      },
    ],
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function service(t, releases, extra = {}) {
  const files = await temporary(t);
  await writeFile(files.catalogFile, JSON.stringify(catalog(releases)));
  const { contentProviderEndpoint, contentProviderKey, contentProviderLimits, sourceAdapters, ...serverOptions } =
    extra;
  const configured = await createConfiguredSources({
    contentProviderEndpoint,
    contentProviderKey,
    contentProviderLimits,
    sourceAdapters,
  });
  const server = await createTextSourceServer({
    ...files,
    sourceRoot: files.content,
    serverKey: KEY,
    moyaOrigin: ORIGIN,
    ...configured,
    ...serverOptions,
  });
  const base = await listen(server);
  t.after(() => server.stop());
  return {
    ...files,
    server,
    base,
    request: (route, options = {}) =>
      fetch(base + route, { ...options, headers: { ...authorization, ...options.headers } }),
  };
}

async function fakeContentProvider(t, handler) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push({ route: request.url, method: request.method, body, headers: request.headers });
    response.setHeader('Content-Type', 'application/json');
    const result = await handler(request, response, body, calls);
    if (result !== undefined && !response.writableEnded) response.end(JSON.stringify(result));
  });
  const endpoint = await listen(server);
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return { endpoint, calls };
}

test('metadata listing is scoped, paginated and never needs the source files', async (t) => {
  const fixture = await service(t, [
    { id: 'one', title: 'First', order: 1, revision: 'r1', file: 'not-present.txt' },
    { id: 'two', title: 'Second', order: 2, contentUrl: CHAPTER_URL },
  ]);
  const health = await (await fixture.request('/v1/health')).json();
  assert.equal(health.protocolVersion, 1);
  assert.equal(health.dataNamespace, 'fixture-data');
  assert.deepEqual(
    (await (await fixture.request('/v1/sources')).json()).items.map(({ id, title, available }) => ({
      id,
      title,
      available,
    })),
    [{ id: 'fixture', title: 'Fixture source', available: true }],
  );
  const works = await (await fixture.request('/v1/sources/fixture/works?query=Fixture')).json();
  assert.equal(works.items.length, 1);
  const detail = await (await fixture.request('/v1/sources/fixture/works/work')).json();
  assert.equal(detail.seriesProfile.chapterSplitMode, 'single');
  const page = await (await fixture.request('/v1/sources/fixture/works/work/releases?limit=1')).json();
  assert.equal(page.items[0].id, 'one');
  assert.equal(typeof page.nextCursor, 'string');
  const nextPage = await (
    await fixture.request(
      `/v1/sources/fixture/works/work/releases?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
    )
  ).json();
  assert.equal(nextPage.items[0].id, 'two');
  assert.equal(JSON.stringify(page).includes('not-present'), false);
  assert.equal(
    JSON.stringify(await (await fixture.request('/v1/sources/fixture/works/work/releases')).json()).includes(
      CHAPTER_URL,
    ),
    false,
  );
  assert.equal((await fixture.request('/v1/sources/fixture/works/other/releases/one/content')).status, 404);
  assert.equal((await fixture.request('/v1/sources/fixture/works/work/releases/one/content')).status, 404);
  for (const query of [
    'limit=0',
    'limit=101',
    'cursor=-1',
    'cursor=abc',
    'limit=1&limit=2',
    'cursor=9999',
    'extra=value',
  ])
    assert.equal((await fixture.request(`/v1/sources/fixture/works/work/releases?${query}`)).status, 400);
});

test('requires bearer credentials and permits only the exact configured browser origin', async (t) => {
  const fixture = await service(t, []);
  assert.equal((await fetch(fixture.base + '/v1/health')).status, 401);
  assert.equal((await fixture.request('/v1/health', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const allowed = await fixture.request('/v1/health', { headers: { Origin: ORIGIN } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(
    allowed.headers.get('x-moya-source-namespace'),
    encodeURIComponent(JSON.stringify(['fixture-instance', 'fixture-data', 'single'])),
  );
  assert.ok(allowed.headers.get('access-control-expose-headers').includes('X-Moya-Source-Namespace'));
  const rejected = await fixture.request('/v1/health', { headers: { Origin: 'https://other.example' } });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);
  assert.equal(
    (
      await fetch(fixture.base + '/v1/health', {
        method: 'OPTIONS',
        headers: {
          Origin: ORIGIN,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Authorization',
        },
      })
    ).status,
    204,
  );
  assert.equal((await fixture.request('/v1/health', { method: 'POST' })).status, 405);
});

test('returns exact local UTF-8 bytes with list/ETag agreement and rejects invalid or oversized bodies', async (t) => {
  const fixture = await service(t, [
    { id: 'one', title: 'First', order: 1, revision: 'revision 1', file: 'one.txt' },
    { id: 'invalid', title: 'Invalid', order: 2, file: 'invalid.txt' },
    { id: 'large', title: 'Large', order: 3, file: 'large.txt' },
  ]);
  const bytes = Buffer.from('\ufeffTitle\r\n\r\n  Body preserved.  \r\n');
  await writeFile(path.join(fixture.content, 'one.txt'), bytes);
  await writeFile(path.join(fixture.content, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  await writeFile(path.join(fixture.content, 'large.txt'), Buffer.alloc(MAX_CONTENT_BYTES + 1));
  const response = await fixture.request('/v1/sources/fixture/works/work/releases/one/content');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const list = await (await fixture.request('/v1/sources/fixture/works/work/releases')).json();
  assert.equal(response.headers.get('etag'), list.items[0].revision);
  assert.equal((await fixture.request('/v1/sources/fixture/works/work/releases/invalid/content')).status, 422);
  assert.equal((await fixture.request('/v1/sources/fixture/works/work/releases/large/content')).status, 413);
});

test('a replacement content provider can be injected without transport-specific settings', async (t) => {
  const calls = [];
  const bytes = Buffer.from('\ufeff  Injected provider text.\r\n');
  const fixture = await service(t, [{ id: 'one', title: 'First', order: 1, contentUrl: CHAPTER_URL }], {
    contentProvider: async (url, signal) => {
      calls.push({ url, signal });
      return bytes;
    },
  });
  const response = await fixture.request('/v1/sources/fixture/works/work/releases/one/content');
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CHAPTER_URL);
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('rejects unsafe catalog paths and realpath escape through a symlink', async (t) => {
  const fixture = await service(t, [{ id: 'escape', title: 'Escape', order: 1, file: 'linked/outside.txt' }]);
  const outside = path.join(fixture.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'outside.txt'), 'Outside fixture.');
  try {
    await symlink(outside, path.join(fixture.content, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('Symlink privilege unavailable');
      return;
    }
    throw error;
  }
  const response = await fixture.request('/v1/sources/fixture/works/work/releases/escape/content');
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'source_path_rejected' });
  await writeFile(
    fixture.catalogFile,
    JSON.stringify(catalog([{ id: 'escape', title: 'Escape', order: 1, file: '../outside/outside.txt' }])),
  );
  await assert.rejects(
    createTextSourceServer({ catalogFile: fixture.catalogFile, sourceRoot: fixture.content, serverKey: KEY }),
    { code: 'invalid_catalog' },
  );
});

test('Content provider bridge polls a scoped job, preserves exact manifest text and always closes the known job', async (t) => {
  const bodyText = '\r\n  Exact Content provider fixture text.  \r\n\r\n';
  const fake = await fakeContentProvider(t, (request) => {
    if (request.url === '/v1/jobs') return { id: JOB_ID, kind: 'novel', state: 'queued' };
    if (request.url.endsWith('/manifest'))
      return { id: JOB_ID, chapterUrl: CHAPTER_URL, kind: 'novel', text: bodyText };
    if (request.url.endsWith('/close')) return { state: 'closed' };
    return { id: JOB_ID, kind: 'novel', state: 'ready' };
  });
  const fixture = await service(t, [{ id: 'one', title: 'First', order: 1, contentUrl: CHAPTER_URL }], {
    contentProviderEndpoint: fake.endpoint,
    contentProviderKey: 'synthetic-content-provider-key',
    contentProviderLimits: { pollMs: 1 },
  });
  const response = await fixture.request('/v1/sources/fixture/works/work/releases/one/content');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), bodyText);
  assert.equal(fake.calls.filter((call) => call.route === '/v1/jobs').length, 1);
  assert.equal(fake.calls[0].body.url, CHAPTER_URL);
  assert.equal(fake.calls[0].body.kind, 'novel');
  assert.match(fake.calls[0].body.requestId, /^[a-f0-9-]{36}$/u);
  assert.equal(fake.calls[0].headers.authorization, 'Bearer synthetic-content-provider-key');
  assert.equal(fake.calls[0].headers['x-lab-request'], '1');
  assert.equal(fake.calls.at(-1).route, `/v1/jobs/${JOB_ID}/close`);
});

test('provider authentication, capacity and job access failures expose only actionable safe codes', async (t) => {
  for (const [upstreamStatus, code, status] of [
    [401, 'content_provider_authentication_required', 502],
    [403, 'content_provider_authentication_required', 502],
    [429, 'content_provider_busy', 503],
    [503, 'content_provider_unavailable', 503],
  ]) {
    const fake = await fakeContentProvider(t, (_request, response) => {
      response.statusCode = upstreamStatus;
      return { error: 'private upstream diagnostic', credential: 'never expose this' };
    });
    await assert.rejects(createContentJobProvider({ endpoint: fake.endpoint, key: 'fixture-key' })(CHAPTER_URL), {
      code,
      status,
      message: code,
    });
  }
  for (const [upstreamError, code, status] of [
    ['manual_login_or_paid_content', 'source_access_required', 403],
    ['manual_viewer_confirmation_required', 'source_verification_required', 409],
    ['novel_too_large', 'source_size_limit', 413],
    ['private diagnostic secret', 'content_provider_job_failed', 502],
  ]) {
    const fake = await fakeContentProvider(t, (request) =>
      request.url.endsWith('/close')
        ? { state: 'closed' }
        : { id: JOB_ID, kind: 'novel', state: 'failed', error: upstreamError },
    );
    await assert.rejects(createContentJobProvider({ endpoint: fake.endpoint, key: 'fixture-key' })(CHAPTER_URL), {
      code,
      status,
      message: code,
    });
    assert.equal(fake.calls.filter((call) => call.route.endsWith('/close')).length, 1);
  }
});

test('Content provider manifest mismatch and redirect fail without leaking upstream diagnostics', async (t) => {
  const fake = await fakeContentProvider(t, (request) => {
    if (request.url === '/v1/jobs') return { id: JOB_ID, kind: 'novel', state: 'ready' };
    if (request.url.endsWith('/manifest'))
      return { id: JOB_ID, chapterUrl: 'https://other.example/private', kind: 'novel', text: 'secret text' };
    return { state: 'closed' };
  });
  const materialize = createContentJobProvider({ endpoint: fake.endpoint, key: 'fixture-key' });
  await assert.rejects(materialize(CHAPTER_URL), { code: 'content_provider_invalid_manifest' });
  assert.equal(fake.calls.at(-1).route, `/v1/jobs/${JOB_ID}/close`);
  const redirect = await fakeContentProvider(t, (_request, response) => {
    response.writeHead(302, { Location: fake.endpoint + '/credential-sink' });
    response.end();
  });
  await assert.rejects(createContentJobProvider({ endpoint: redirect.endpoint, key: 'fixture-key' })(CHAPTER_URL), {
    code: 'content_provider_request_failed',
  });
  assert.equal(
    fake.calls.some((call) => call.route === '/credential-sink'),
    false,
  );
});

test('Content provider abort during a streamed body uses an independent bounded close request', async (t) => {
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const fake = await fakeContentProvider(t, (request, response) => {
    if (request.url === '/v1/jobs') return { id: JOB_ID, kind: 'novel', state: 'ready' };
    if (request.url.endsWith('/manifest')) {
      response.write('{"text":"');
      started();
      return;
    }
    return { state: 'closed' };
  });
  const abort = new AbortController();
  const pending = createContentJobProvider({
    endpoint: fake.endpoint,
    key: 'fixture-key',
    timeoutMs: 1_000,
    stallMs: 200,
    cleanupMs: 100,
  })(CHAPTER_URL, abort.signal);
  await waiting;
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fake.calls.at(-1).route, `/v1/jobs/${JOB_ID}/close`);
});

test('Content provider enforces response bytes and an inactivity timeout through error-body reads', async (t) => {
  const large = await fakeContentProvider(t, (_request, response) => {
    response.writeHead(200, { 'Content-Length': 5 * 1024 * 1024 });
    response.end('{}');
  });
  await assert.rejects(createContentJobProvider({ endpoint: large.endpoint, key: 'fixture-key' })(CHAPTER_URL), {
    code: 'content_provider_response_limit',
  });
  const stalled = await fakeContentProvider(t, (_request, response) => {
    response.writeHead(500);
    response.write('{"error":"private');
  });
  const started = Date.now();
  await assert.rejects(
    createContentJobProvider({ endpoint: stalled.endpoint, key: 'fixture-key', stallMs: 50, timeoutMs: 1_000 })(
      CHAPTER_URL,
    ),
    { code: 'content_provider_body_timeout' },
  );
  assert.ok(Date.now() - started < 1_000);
});

test('rejects oversized catalog JSON before parsing or serving it', async (t) => {
  const files = await temporary(t);
  await writeFile(files.catalogFile, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
  await assert.rejects(
    createTextSourceServer({ catalogFile: files.catalogFile, sourceRoot: files.content, serverKey: KEY }),
    { code: 'source_size_limit' },
  );
});

test('shutdown cancels a live Content provider request and closes its known job', async (t) => {
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const fake = await fakeContentProvider(t, (request, response) => {
    if (request.url === '/v1/jobs') return { id: JOB_ID, kind: 'novel', state: 'ready' };
    if (request.url.endsWith('/manifest')) {
      response.write('{"text":"');
      started();
      return;
    }
    return { state: 'closed' };
  });
  const fixture = await service(t, [{ id: 'one', title: 'First', order: 1, contentUrl: CHAPTER_URL }], {
    contentProviderEndpoint: fake.endpoint,
    contentProviderKey: 'fixture-key',
    contentProviderLimits: { cleanupMs: 100 },
  });
  const response = fixture.request('/v1/sources/fixture/works/work/releases/one/content');
  await waiting;
  await fixture.server.stop();
  assert.equal((await response).status, 503);
  assert.equal(fake.calls.at(-1).route, `/v1/jobs/${JOB_ID}/close`);
});
