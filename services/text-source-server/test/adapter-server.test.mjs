import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { createTextSourceServer } from '../src/server.mjs';
import { TXT_PROFILE } from '../src/catalog.mjs';

const KEY = 'synthetic-adapter-server-key';
const ROOT = '/v1/sources/dynamic/works';
const contentPath = `${ROOT}/book/releases/chapter/content`;
const work = { id: 'book', title: 'Remote work', author: 'Synthetic author' };
const release = { id: 'chapter', title: 'Remote chapter', sourceOrder: 1 };
const bytes = Buffer.from('\ufeffExact remote text.\r\n\r\n  Preserved body.  \r\n');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function adapter(overrides = {}) {
  return {
    apiVersion: 1,
    id: 'dynamic',
    title: 'Synthetic dynamic source',
    capabilities: ['search', 'txt-content'],
    async listWorks() {
      return { items: [work] };
    },
    async getWork() {
      return { ...work, seriesProfile: TXT_PROFILE };
    },
    async listReleases() {
      return { items: [release] };
    },
    async getContent() {
      return { bytes };
    },
    ...overrides,
  };
}

test('authenticated optional cover route returns bounded image bytes and rejects non-images', async (t) => {
  let contentType = 'image/png';
  const image = Buffer.from([137, 80, 78, 71]);
  const f = await service(t, [
    adapter({ capabilities: ['txt-content', 'cover-read'], getCover: async () => ({ bytes: image, contentType }) }),
  ]);
  const response = await f.request(`${ROOT}/book/cover`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  assert.equal((await f.request(`${ROOT}/book/cover`, { headers: { Authorization: '' } })).status, 401);
  contentType = 'image/svg+xml';
  assert.equal((await f.request(`${ROOT}/book/cover`)).status, 502);
  assert.equal((await f.request(`${ROOT}/book/cover?url=http://localhost`)).status, 400);
});

async function service(t, additionalAdapters, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'moya-adapter-server-'));
  let server;
  t.after(async () => {
    await server?.stop();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('moya-adapter-server-'));
    await rm(resolved, { recursive: true, force: true });
  });
  const sourceRoot = path.join(directory, 'content');
  await mkdir(sourceRoot);
  const catalogFile = path.join(directory, 'catalog.json');
  await writeFile(
    catalogFile,
    JSON.stringify({
      instanceId: 'fixture-instance',
      dataNamespace: 'fixture-data',
      sources: [],
    }),
  );
  server = await createTextSourceServer({
    catalogFile,
    sourceRoot,
    serverKey: KEY,
    additionalAdapters,
    shutdownGraceMs: 30,
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    request: (route, options = {}) =>
      fetch(base + route, {
        ...options,
        headers: { Authorization: `Bearer ${KEY}`, ...options.headers },
      }),
  };
}

test('generic routes use adapter methods with opaque work/release cursors and exact content', async (t) => {
  const calls = [];
  const fixture = await service(t, [
    adapter({
      async listWorks(input) {
        calls.push(['listWorks', input]);
        return input.cursor ? { items: [work] } : { items: [work], nextCursor: 'remote:works/+token' };
      },
      async getWork(input) {
        calls.push(['getWork', input]);
        return { ...work, seriesProfile: TXT_PROFILE };
      },
      async listReleases(input) {
        calls.push(['listReleases', input]);
        return { items: [release], nextCursor: 'remote:chapters/+token' };
      },
      async getContent(input) {
        calls.push(['getContent', input]);
        return { bytes, revision: '"synthetic-remote-revision"' };
      },
    }),
  ]);
  const sources = await (await fixture.request('/v1/sources')).json();
  assert.deepEqual(
    sources.items.map((source) => source.id),
    ['dynamic'],
  );
  const first = await (await fixture.request(`${ROOT}?query=Remote&limit=1`)).json();
  assert.equal(first.nextCursor, 'remote:works/+token');
  assert.equal(
    (await fixture.request(`${ROOT}?query=Remote&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).status,
    200,
  );
  assert.equal((await fixture.request(`${ROOT}/book`)).status, 200);
  const chapters = await (await fixture.request(`${ROOT}/book/releases?limit=1&cursor=opaque-in`)).json();
  assert.equal(chapters.nextCursor, 'remote:chapters/+token');
  const content = await fixture.request(contentPath);
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
  assert.equal(content.headers.get('etag'), '"synthetic-remote-revision"');
  assert.deepEqual(
    calls.map(([method]) => method),
    ['listWorks', 'listWorks', 'getWork', 'listReleases', 'getContent'],
  );
  assert.equal(calls[0][1].query, 'Remote');
  assert.equal(calls[1][1].cursor, first.nextCursor);
  assert.equal(calls[3][1].cursor, 'opaque-in');
  assert.equal(calls[4][1].workId, 'book');
  assert.equal(calls[4][1].releaseId, 'chapter');
  assert.ok(calls.every(([, input]) => input.signal instanceof AbortSignal));
  const invoked = calls.length;
  for (const route of [
    `${ROOT}?query=a&query=b`,
    `${ROOT}/book?query=bad`,
    `${contentPath}?cursor=bad`,
    `${ROOT}/book/releases?limit=101`,
  ])
    assert.equal((await fixture.request(route)).status, 400);
  assert.equal(calls.length, invoked);
});

test('server accepts a provider callback rather than transport configuration', async (t) => {
  await assert.rejects(service(t, [], { contentProvider: { endpoint: 'http://127.0.0.1:1' } }), {
    code: 'invalid_content_provider_configuration',
  });
});

test('noncooperative adapter timeouts release all metadata and content slots', async (t) => {
  const inputs = [];
  let blocked = true;
  const never = new Promise(() => {});
  const invoke = (input, value) => {
    inputs.push(input);
    return blocked ? never : value;
  };
  const fixture = await service(
    t,
    [
      adapter({
        listWorks: (input) => invoke(input, { items: [work] }),
        getWork: (input) => invoke(input, { ...work, seriesProfile: TXT_PROFILE }),
        listReleases: (input) => invoke(input, { items: [release] }),
        getContent: (input) => invoke(input, { bytes }),
      }),
    ],
    { metadataTimeoutMs: 60, contentTimeoutMs: 100 },
  );
  const routes = [
    ROOT,
    ROOT,
    ROOT,
    `${ROOT}/book`,
    `${ROOT}/book`,
    `${ROOT}/book`,
    `${ROOT}/book/releases`,
    `${ROOT}/book/releases`,
    contentPath,
    contentPath,
  ];
  const responses = await Promise.all(routes.map((route) => fixture.request(route)));
  for (const response of responses) {
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: 'request_timeout' });
  }
  assert.equal(inputs.length, 10);
  assert.ok(inputs.every((input) => input.signal.aborted && input.signal.reason.code === 'request_timeout'));
  blocked = false;
  for (const response of await Promise.all(routes.map((route) => fixture.request(route))))
    assert.equal(response.status, 200);
});

test('metadata/content concurrency limits are independent and release on completion', async (t) => {
  const metadataReady = deferred();
  const contentReady = deferred();
  const metadata = deferred();
  const content = deferred();
  let metadataCount = 0;
  let contentCount = 0;
  const fixture = await service(t, [
    adapter({
      async listWorks() {
        if (++metadataCount === 8) metadataReady.resolve();
        await metadata.promise;
        return { items: [work] };
      },
      async getContent() {
        if (++contentCount === 2) contentReady.resolve();
        await content.promise;
        return { bytes };
      },
    }),
  ]);
  const requests = Array.from({ length: 8 }, () => fixture.request(ROOT));
  await metadataReady.promise;
  assert.equal((await fixture.request(ROOT)).status, 429);
  const contentRequests = Array.from({ length: 2 }, () => fixture.request(contentPath));
  await contentReady.promise;
  assert.equal((await fixture.request(contentPath)).status, 429);
  metadata.resolve();
  content.resolve();
  for (const response of await Promise.all([...requests, ...contentRequests])) assert.equal(response.status, 200);
  assert.equal((await fixture.request(ROOT)).status, 200);
  assert.equal((await fixture.request(contentPath)).status, 200);
});

test('client disconnect reaches every adapter method and promptly frees a full metadata pool', async (t) => {
  const ready = deferred();
  const allAborted = deferred();
  const signals = [];
  let aborted = 0;
  let blocked = true;
  const track = (input, value) => {
    if (!blocked) return value;
    signals.push(input.signal);
    input.signal.addEventListener(
      'abort',
      () => {
        if (++aborted === 10) allAborted.resolve();
      },
      { once: true },
    );
    if (signals.length === 10) ready.resolve();
    return new Promise(() => {});
  };
  const fixture = await service(t, [
    adapter({
      listWorks: (input) => track(input, { items: [work] }),
      getWork: (input) => track(input, { ...work, seriesProfile: TXT_PROFILE }),
      listReleases: (input) => track(input, { items: [release] }),
      getContent: (input) => track(input, { bytes }),
    }),
  ]);
  const routes = [
    ROOT,
    ROOT,
    ROOT,
    `${ROOT}/book`,
    `${ROOT}/book`,
    `${ROOT}/book`,
    `${ROOT}/book/releases`,
    `${ROOT}/book/releases`,
    contentPath,
    contentPath,
  ];
  const aborts = routes.map(() => new AbortController());
  const requests = routes.map((route, index) =>
    fixture.request(route, { signal: aborts[index].signal }).catch((error) => error),
  );
  await ready.promise;
  aborts.forEach((abort) => abort.abort());
  await Promise.all(requests);
  await allAborted.promise;
  await nextTurn();
  assert.ok(signals.every((signal) => signal.reason.code === 'request_cancelled'));
  blocked = false;
  for (const response of await Promise.all(routes.map((route) => fixture.request(route))))
    assert.equal(response.status, 200);
});

test('adapter failures stay redacted and late rejection cannot alter a timed-out response', async (t) => {
  const late = deferred();
  const fixture = await service(
    t,
    [
      adapter({
        async listWorks() {
          throw new Error('Bearer private-key https://private.example/body');
        },
        getContent: () => late.promise,
      }),
    ],
    { contentTimeoutMs: 30 },
  );
  const failure = await fixture.request(ROOT);
  assert.equal(failure.status, 502);
  assert.deepEqual(await failure.json(), { error: 'adapter_request_failed' });
  const response = await fixture.request(contentPath);
  assert.equal(response.status, 504);
  late.reject(new Error('late private upstream body'));
  await nextTurn();
  assert.deepEqual(await response.json(), { error: 'request_timeout' });
});

test('shutdown returns while a cancelled adapter promise remains pending', async (t) => {
  const entered = deferred();
  let signal;
  const fixture = await service(t, [
    adapter({
      getContent(input) {
        signal = input.signal;
        entered.resolve();
        return new Promise(() => {});
      },
    }),
  ]);
  const pending = fixture.request(contentPath);
  await entered.promise;
  const start = Date.now();
  await fixture.server.stop();
  assert.ok(Date.now() - start < 1_000);
  assert.equal(signal.aborted, true);
  assert.equal((await pending).status, 503);
});
