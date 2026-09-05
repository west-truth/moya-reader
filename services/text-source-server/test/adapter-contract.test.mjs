import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog, MAX_CONTENT_BYTES, SourceError, TXT_PROFILE } from '../src/catalog.mjs';
import { parseListParameters } from '../src/adapter-contract.mjs';
import { createAdapterRegistry } from '../src/adapter-registry.mjs';
import { createStaticCatalogAdapter } from '../src/static-catalog-adapter.mjs';

const work = { id: 'work', title: 'Synthetic work' };
function adapter(overrides = {}) {
  return {
    apiVersion: 1,
    id: 'fixture',
    title: 'Fixture source',
    capabilities: ['search', 'txt-content'],
    async listWorks() {
      return { items: [work] };
    },
    async getWork() {
      return { ...work, seriesProfile: TXT_PROFILE };
    },
    async listReleases() {
      return { items: [{ id: 'one', title: 'One', sourceOrder: 1 }] };
    },
    async getContent() {
      return { bytes: Buffer.from('Synthetic body.') };
    },
    ...overrides,
  };
}
function wrapped(overrides) {
  return createAdapterRegistry([adapter(overrides)]).get('fixture');
}

test('registry rejects incompatible, incomplete and duplicate trusted adapters before serving', () => {
  for (const override of [
    { apiVersion: 2 },
    { id: '../source' },
    { title: '' },
    { getContent: undefined },
    { capabilities: ['search'] },
    { capabilities: ['txt-content', 'eval'] },
    { capabilities: ['txt-content', 'txt-content'] },
  ])
    assert.throws(() => createAdapterRegistry([adapter(override)]), { code: 'invalid_source_adapter' });
  assert.throws(() => createAdapterRegistry([adapter(), adapter()]), { code: 'duplicate_source_adapter' });
  const registry = createAdapterRegistry([adapter({ id: 'z' }), adapter({ id: 'a' })]);
  const first = registry.listSources({ limit: 1 });
  assert.equal(first.items[0].id, 'a');
  assert.equal(registry.listSources({ cursor: first.nextCursor }).items[0].id, 'z');
  assert.throws(() => registry.get('missing'), { status: 404 });
});

test('query boundary accepts opaque cursors and rejects malformed or unbounded pagination', async () => {
  const opaque = 'chapter:next/part?offset=2&edition=one';
  let received;
  const source = wrapped({
    async listWorks(input) {
      received = input;
      return { items: [] };
    },
  });
  await source.listWorks(
    parseListParameters(new URLSearchParams({ cursor: opaque, query: 'Story', limit: '1' }), { search: true }),
  );
  assert.equal(received.cursor, opaque);
  assert.equal(received.query, 'Story');
  assert.equal(received.limit, 1);
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=01', 'limit=1&limit=2', 'unknown=x', 'cursor='])
    assert.throws(() => parseListParameters(new URLSearchParams(query)), SourceError);
  assert.throws(() => parseListParameters(new URLSearchParams({ cursor: 'x'.repeat(513) })), {
    code: 'invalid_pagination',
  });
  assert.throws(() => parseListParameters(new URLSearchParams({ query: 'x'.repeat(201) }), { search: true }), {
    code: 'invalid_query',
  });
  assert.throws(() => wrapped({ capabilities: undefined }).listWorks({ query: 'story' }), {
    code: 'search_not_supported',
  });
});

test('metadata projection hides adapter internals and rejects duplicates, wrong scope and stalled cursors', async () => {
  const source = wrapped({
    async listWorks() {
      return { items: [{ ...work, privateUrl: 'https://private.example' }], privateToken: 'secret' };
    },
  });
  assert.deepEqual(await source.listWorks(), { items: [work] });
  for (const result of [
    { items: [work, work] },
    { items: [work], nextCursor: 'same' },
    { items: [], nextCursor: 'next' },
    { items: [{ ...work, id: 'bad/id' }] },
    { items: [work, { ...work, id: 'two' }] },
  ]) {
    await assert.rejects(
      wrapped({
        async listWorks() {
          return result;
        },
      }).listWorks({ cursor: 'same', limit: 1 }),
      { code: 'invalid_adapter_response' },
    );
  }
  await assert.rejects(
    wrapped({
      async getWork() {
        return { ...work, id: 'other', seriesProfile: TXT_PROFILE };
      },
    }).getWork({ workId: 'work' }),
    { code: 'invalid_adapter_response' },
  );
  await assert.rejects(
    wrapped({
      async getWork() {
        return { ...work, seriesProfile: { ...TXT_PROFILE, format: 'epub' } };
      },
    }).getWork({ workId: 'work' }),
    { code: 'invalid_adapter_response' },
  );
  await assert.rejects(
    wrapped({
      async listReleases() {
        return { items: [{ id: 'one', title: 'One', sourceOrder: Infinity }] };
      },
    }).listReleases({ workId: 'work' }),
    { code: 'invalid_adapter_response' },
  );
});

test('metadata response limit counts UTF-8 bytes, including a bounded page of valid long descriptions', async () => {
  const items = Array.from({ length: 100 }, (_, index) => ({
    id: `work-${index}`,
    title: 'Synthetic title',
    description: '\uac00'.repeat(4_000),
  }));
  await assert.rejects(
    wrapped({
      async listWorks() {
        return { items };
      },
    }).listWorks({ limit: 100 }),
    { code: 'adapter_metadata_limit' },
  );
});

test('metadata field limits match the Moya broker for sources, works, authors, descriptions and releases', async () => {
  const title = 't'.repeat(256);
  const boundary = { ...work, title, author: 'a'.repeat(256), description: 'd'.repeat(8_192) };
  const source = wrapped({
    title,
    async listWorks() {
      return { items: [boundary] };
    },
    async getWork() {
      return { ...boundary, seriesProfile: TXT_PROFILE };
    },
    async listReleases() {
      return { items: [{ id: 'one', title, sourceOrder: 1 }] };
    },
  });
  assert.equal(source.title, title);
  assert.deepEqual((await source.listWorks()).items[0], boundary);
  assert.deepEqual(await source.getWork({ workId: 'work' }), { ...boundary, seriesProfile: TXT_PROFILE });
  assert.equal((await source.listReleases({ workId: 'work' })).items[0].title, title);
  assert.throws(() => wrapped({ title: 't'.repeat(257) }), { code: 'invalid_source_adapter' });
  for (const overflow of [
    { title: 't'.repeat(257) },
    { author: 'a'.repeat(257) },
    { description: 'd'.repeat(8_193) },
  ]) {
    const invalid = wrapped({
      async listWorks() {
        return { items: [{ ...work, ...overflow }] };
      },
      async getWork() {
        return { ...work, ...overflow, seriesProfile: TXT_PROFILE };
      },
    });
    await assert.rejects(invalid.listWorks(), { code: 'invalid_adapter_response' });
    await assert.rejects(invalid.getWork({ workId: 'work' }), { code: 'invalid_adapter_response' });
  }
  await assert.rejects(
    wrapped({
      async listReleases() {
        return { items: [{ id: 'one', title: 'r'.repeat(257), sourceOrder: 1 }] };
      },
    }).listReleases({ workId: 'work' }),
    { code: 'invalid_adapter_response' },
  );
});

test('content boundary preserves exact UTF-8 bytes and bounds content and wire revisions', async () => {
  const bytes = Buffer.from('\ufeffTitle\r\n\r\n  Body preserved.  \r\n');
  const source = wrapped({
    async getContent() {
      return { bytes, revision: '"revision-1"', privateField: 'secret' };
    },
  });
  assert.deepEqual(await source.getContent({ workId: 'work', releaseId: 'one' }), { bytes, revision: '"revision-1"' });
  for (const [result, code] of [
    [{ bytes: Buffer.alloc(MAX_CONTENT_BYTES + 1) }, 'source_size_limit'],
    [{ bytes: Buffer.from([0xc3, 0x28]) }, 'invalid_utf8_content'],
    [{ bytes: 'body' }, 'invalid_adapter_response'],
    [{ bytes, revision: 'unsafe\r\nHeader: value' }, 'invalid_adapter_response'],
  ])
    await assert.rejects(
      wrapped({
        async getContent() {
          return result;
        },
      }).getContent({ workId: 'work', releaseId: 'one' }),
      { code },
    );
});

test('adapter errors expose only safe SourceError codes and late abort cannot publish results', async () => {
  for (const error of [
    new Error('private credential/body'),
    new SourceError(502, 'Private body!'),
    new SourceError(200, 'invalid'),
  ]) {
    await assert.rejects(
      wrapped({
        async listWorks() {
          throw error;
        },
      }).listWorks(),
      { status: 502, code: 'adapter_request_failed', message: 'adapter_request_failed' },
    );
  }
  await assert.rejects(
    wrapped({
      async listWorks() {
        throw new SourceError(404, 'not_found');
      },
    }).listWorks(),
    { status: 404, code: 'not_found' },
  );
  let complete;
  const source = wrapped({
    listWorks() {
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  });
  const abort = new AbortController();
  const pending = source.listWorks({ signal: abort.signal });
  abort.abort();
  complete({ items: [work] });
  await assert.rejects(pending, { name: 'AbortError' });
  let called = false;
  const stopped = wrapped({
    async listWorks() {
      called = true;
      return { items: [] };
    },
  });
  await assert.rejects(stopped.listWorks({ signal: abort.signal }), { name: 'AbortError' });
  assert.equal(called, false);
});

test('wire revisions accept ASCII entity tags and reject values that cannot be sent as ETag headers', async () => {
  for (const revision of ['"revision-1"', 'W/"revision-1"', '""']) {
    const result = await wrapped({
      async getContent() {
        return { bytes: Buffer.from('Body.'), revision };
      },
    }).getContent({ workId: 'work', releaseId: 'one' });
    assert.equal(result.revision, revision);
  }
  for (const revision of [
    '한글revision',
    '"한글revision"',
    'unquoted',
    '"with space"',
    '"a"b"',
    `"${'x'.repeat(255)}"`,
  ]) {
    const source = wrapped({
      async getContent() {
        return { bytes: Buffer.from('Body.'), revision };
      },
      async listReleases() {
        return { items: [{ id: 'one', title: 'One', sourceOrder: 1, revision }] };
      },
    });
    await assert.rejects(source.getContent({ workId: 'work', releaseId: 'one' }), { code: 'invalid_adapter_response' });
    await assert.rejects(source.listReleases({ workId: 'work' }), { code: 'invalid_adapter_response' });
  }
});

async function staticFixture(t, metadata = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moya-adapter-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('moya-adapter-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const content = path.join(root, 'content');
  await mkdir(content);
  const catalogFile = path.join(root, 'catalog.json');
  const releases = [
    { id: 'one', title: metadata.releaseTitle ?? 'One', order: 1, revision: 'r1', file: 'one.txt' },
    { id: 'two', title: 'Two', order: 2, contentUrl: 'https://source.example/release/two' },
  ];
  await writeFile(
    catalogFile,
    JSON.stringify({
      instanceId: 'fixture',
      dataNamespace: 'v1',
      sources: [
        {
          id: 'fixture',
          name: metadata.sourceTitle ?? 'Fixture',
          works: [
            {
              id: 'a',
              title: metadata.workTitle ?? 'Alpha',
              author: metadata.author ?? 'Shared author',
              ...(metadata.description === undefined ? {} : { description: metadata.description }),
              releases,
            },
            { id: 'b', title: 'Beta', author: 'Shared author', releases: [] },
          ],
        },
      ],
    }),
  );
  const catalog = await loadCatalog(catalogFile, content);
  return { catalog, source: catalog.sources.get('fixture'), content };
}

test('static catalog adapter keeps metadata body-free and scopes cursors to search and work', async (t) => {
  const fixture = await staticFixture(t);
  const source = createAdapterRegistry([createStaticCatalogAdapter(fixture.catalog, fixture.source)]).get('fixture');
  const first = await source.listWorks({ limit: 1 });
  assert.equal(first.items[0].id, 'a');
  assert.equal((await source.listWorks({ cursor: first.nextCursor })).items[0].id, 'b');
  await assert.rejects(source.listWorks({ query: 'Shared', cursor: first.nextCursor }), { code: 'invalid_pagination' });
  const page = await source.listReleases({ workId: 'a', limit: 1 });
  assert.equal((await source.listReleases({ workId: 'a', cursor: page.nextCursor })).items[0].id, 'two');
  await assert.rejects(source.listReleases({ workId: 'b', cursor: page.nextCursor }), { code: 'invalid_pagination' });
  await assert.rejects(source.getContent({ workId: 'b', releaseId: 'one' }), { code: 'not_found' });
  await assert.rejects(source.getContent({ workId: 'a', releaseId: 'one' }), { code: 'content_unavailable' });
  await assert.rejects(source.getContent({ workId: 'a', releaseId: 'two' }), {
    code: 'content_provider_not_configured',
  });
});

test('static adapter preserves file and Content provider bytes and existing list/content revision agreement', async (t) => {
  const fixture = await staticFixture(t);
  const bytes = Buffer.from('\ufeff  Local exact text.\r\n');
  const providerBytes = Buffer.from('\r\n  Content provider exact text.  \n');
  await writeFile(path.join(fixture.content, 'one.txt'), bytes);
  let requested;
  const source = createAdapterRegistry([
    createStaticCatalogAdapter(fixture.catalog, fixture.source, async (url, signal) => {
      requested = { url, signal };
      return providerBytes;
    }),
  ]).get('fixture');
  const releases = await source.listReleases({ workId: 'a' });
  const local = await source.getContent({ workId: 'a', releaseId: 'one' });
  assert.deepEqual(local.bytes, bytes);
  assert.equal(local.revision, releases.items[0].revision);
  assert.equal(releases.items[1].revision, undefined);
  const signal = new AbortController().signal;
  const contentProvider = await source.getContent({ workId: 'a', releaseId: 'two', signal });
  assert.deepEqual(contentProvider.bytes, providerBytes);
  assert.match(contentProvider.revision, /^"[a-f0-9]{64}"$/u);
  assert.deepEqual(requested, { url: 'https://source.example/release/two', signal });
});

test('legacy static catalog metadata is safely bounded without changing IDs, search, revisions or source bytes', async (t) => {
  const metadata = {
    sourceTitle: `${'s'.repeat(255)}😀tail`,
    workTitle: `${'w'.repeat(255)}😀tail`,
    author: `${' '.repeat(270)}Final author`,
    description: `${'d'.repeat(8_191)}😀tail`,
    releaseTitle: 'r'.repeat(500),
  };
  const fixture = await staticFixture(t, metadata);
  const source = createAdapterRegistry([createStaticCatalogAdapter(fixture.catalog, fixture.source)]).get('fixture');
  assert.equal(source.title, 's'.repeat(255));
  const listed = await source.listWorks({ query: 'tail' });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].id, 'a');
  assert.equal(listed.items[0].title, 'w'.repeat(255));
  assert.equal(listed.items[0].author, 'Final author');
  assert.equal(listed.items[0].description, 'd'.repeat(8_191));
  assert.deepEqual(await source.getWork({ workId: 'a' }), { ...listed.items[0], seriesProfile: TXT_PROFILE });
  const release = (await source.listReleases({ workId: 'a' })).items[0];
  assert.equal(release.id, 'one');
  assert.equal(release.title, 'r'.repeat(256));
  const bytes = Buffer.from('\ufeffUnchanged synthetic bytes.\r\n');
  await writeFile(path.join(fixture.content, 'one.txt'), bytes);
  const content = await source.getContent({ workId: 'a', releaseId: 'one' });
  assert.deepEqual(content.bytes, bytes);
  assert.equal(content.revision, release.revision);
  assert.equal(fixture.source.name, metadata.sourceTitle);
  assert.equal(fixture.source.workMap.get('a').title, metadata.workTitle);
  assert.equal(fixture.source.workMap.get('a').description, metadata.description);
  assert.equal(fixture.source.workMap.get('a').releaseMap.get('one').title, metadata.releaseTitle);
});
