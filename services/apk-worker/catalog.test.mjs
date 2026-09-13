import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApkSourceCatalog } from './catalog.mjs';

async function fixture(t, count = 1) {
  const root = await mkdtemp(join(tmpdir(), 'moya-apk-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = {
    pkg: 'org.example.manga',
    digest: 'a'.repeat(64),
    sources: [{ id: '123', name: 'Novel images', lang: 'ko' }],
  };
  const calls = [];
  const tools = {
    worker: () => ({
      busy: false,
      close() {},
      async request(method, input) {
        calls.push({ method, input });
        if (method === 'list')
          return {
            items: Array.from({ length: count }, (_, n) => ({
              url: `/works/${n}`,
              title: `Work ${n}`,
              cover: 'https://example.org/cover.jpg',
            })),
            hasNextPage: false,
          };
        if (method === 'detail') return { title: 'Detailed work', description: 'Description' };
        if (method === 'chapters')
          return [
            { url: '/chapter/2', title: 'Two', number: 2 },
            { url: '/chapter/1', title: 'One', number: 1 },
          ];
        if (method === 'pages') return [{ index: 0, imageUrl: 'https://example.org/page.jpg', url: '' }];
        if (method === 'image' || method === 'cover')
          return { contentType: 'image/jpeg', base64: Buffer.from([255, 216, 255, 217]).toString('base64') };
        throw new Error(method);
      },
    }),
  };
  const store = { root, snapshot: () => ({ packages: [record] }) };
  const catalog = new ApkSourceCatalog(store, tools);
  await catalog.refresh();
  t.after(() => catalog.close());
  const source = catalog.getSources()[0].descriptor.id;
  const invoke = (method, input = {}) =>
    catalog.invoke(source, `source.${method}`, input, new AbortController().signal);
  return { catalog, store, tools, source, calls, invoke };
}
test('legacy pages larger than 500 remain browsable without repeating upstream requests', async (t) => {
  const { invoke, calls } = await fixture(t, 764);
  const first = (await invoke('listWorks')).result;
  const second = (await invoke('listWorks', { cursor: first.nextCursor })).result;
  assert.equal(first.items.length, 500);
  assert.equal(second.items.length, 264);
  assert.equal(second.nextCursor, undefined);
  assert.equal(calls.filter((c) => c.method === 'list').length, 1);
  await assert.rejects(invoke('listWorks', { cursor: first.nextCursor, query: 'different' }), /cursor/);
});

test('large chapters pass the former count and byte limits and retain page order', async (t) => {
  const { invoke, tools } = await fixture(t);
  const base = tools.worker;
  tools.worker = (...args) => {
    const worker = base(...args);
    const original = worker.request;
    worker.request = async (method, input) => {
      if (method === 'pages') return Array.from({ length: 300 }, (_, index) => ({ index }));
      if (method === 'image')
        return { contentType: 'image/jpeg', base64: Buffer.alloc(128 * 1024, input.index % 256).toString('base64') };
      return original(method, input);
    };
    return worker;
  };
  const workId = (await invoke('listWorks')).result.items[0].id;
  const releaseId = (await invoke('listReleases', { workId })).result.items[0].id;
  const { result, assets } = await invoke('getContent', { workId, releaseId });
  assert.equal(result.assets.length, 300);
  assert.equal(
    [...assets.values()].reduce((sum, a) => sum + a.size, 0),
    37.5 * 1024 * 1024,
  );
  assert.equal(new Uint8Array(await assets.get(result.assets[299].handle).arrayBuffer())[0], 299 % 256);
});
test('disable and re-enable fence already running results even for the same APK digest', async (t) => {
  const { store, tools, invoke } = await fixture(t);
  let finish;
  tools.worker = () => ({
    busy: true,
    close() {},
    request: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const listing = invoke('listWorks');
  const rejected = assert.rejects(listing, /package_generation_changed/);
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  store.snapshot().packages[0].activation = 'new-activation';
  finish({ items: [], hasNextPage: false });
  await rejected;
});
test('persisted work identities and chapter order feed the ordinary image contract', async (t) => {
  const { invoke, store, tools, source, calls } = await fixture(t);
  const work = (await invoke('listWorks')).result.items[0];
  assert.match(work.id, /^[a-f0-9]{64}$/);
  assert.equal((await invoke('getWork', { workId: work.id })).result.id, work.id);
  const reopened = new ApkSourceCatalog(store, tools);
  await reopened.refresh();
  t.after(() => reopened.close());
  const releases = (
    await reopened.invoke(source, 'source.listReleases', { workId: work.id }, new AbortController().signal)
  ).result.items;
  assert.deepEqual(
    releases.map((r) => r.title),
    ['One', 'Two'],
  );
  const downloaded = await invoke('getContent', { workId: work.id, releaseId: releases[0].id });
  assert.equal(downloaded.result.kind, 'images');
  assert.equal(downloaded.assets.size, 1);
  assert.equal(calls.filter((c) => c.method === 'chapters').length, 1);
  await assert.rejects(invoke('getContent', { workId: work.id, releaseId: 'bad' }), /release_unavailable/);
  await assert.rejects(invoke('getWork', { workId: '../secret' }), /invalid_source_work/);
});
test('original preferences use the current worker and reject stale replies', async (t) => {
  const { catalog, store, tools } = await fixture(t);
  let revision = 3,
    resolveRead,
    closed = 0;
  const record = store.snapshot().packages[0];
  store.snapshot = () => ({ revision, packages: [record] });
  const calls = [];
  tools.worker = () => ({
    busy: false,
    close() {
      closed++;
    },
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'preferences-save') return { saved: true };
      return new Promise((resolve) => {
        resolveRead = resolve;
      });
    },
  });
  const loading = catalog.preferences(record.pkg);
  resolveRead({ fields: [{ key: '["123","enabled"]', kind: 'boolean', value: false }], groups: [] });
  assert.equal((await loading).networkPolicy, 'direct');
  const values = { '["123","enabled"]': true };
  await catalog.preferences(record.pkg, values);
  assert.deepEqual(calls[1], { method: 'preferences-save', params: { values } });
  const stale = catalog.preferences(record.pkg);
  revision++;
  record.activation = 'changed';
  resolveRead({ fields: [] });
  await assert.rejects(stale, /install_conflict/);
  await catalog.refresh();
  assert.equal(closed, 1);
});
test('changed settings invalidate cached listings, details and chapters while keeping library IDs stable', async (t) => {
  const { invoke, catalog, store, calls } = await fixture(t, 501);
  const listing = (await invoke('listWorks')).result;
  const workId = listing.items[0].id;
  await invoke('getWork', { workId });
  const chapters = (await invoke('listReleases', { workId })).result;
  await invoke('getWork', { workId });
  await invoke('listReleases', { workId });
  assert.equal(calls.filter((c) => c.method === 'chapters').length, 1);
  assert.equal(calls.filter((c) => c.method === 'detail').length, 1);
  const sourceId = catalog.getSources()[0].descriptor.id;
  store.snapshot().packages[0].activation = 'settings-changed';
  await catalog.refresh();
  assert.equal(catalog.getSources()[0].descriptor.id, sourceId);
  await assert.rejects(invoke('listWorks', { cursor: listing.nextCursor }), /invalid_source_cursor/);
  assert.equal((await invoke('getWork', { workId })).result.id, workId);
  assert.deepEqual((await invoke('listReleases', { workId })).result, chapters);
  assert.equal(calls.filter((c) => c.method === 'chapters').length, 2);
  assert.equal(calls.filter((c) => c.method === 'detail').length, 2);
});

test('list refresh preserves detail cache and covers never require detail when the list has a fresh URL', async (t) => {
  const { invoke, calls, tools } = await fixture(t);
  let now = 1000000,
    cover = 'https://example.org/first.jpg',
    failDetail = false;
  t.mock.method(Date, 'now', () => now);
  const base = tools.worker;
  tools.worker = (...args) => {
    const worker = base(...args),
      original = worker.request;
    worker.request = async (method, input) => {
      if (method === 'detail' && failDetail) throw new Error('upstream_offline');
      const result = await original(method, input);
      if (method === 'list') result.items[0].cover = cover;
      return result;
    };
    return worker;
  };
  const workId = (await invoke('listWorks')).result.items[0].id;
  await invoke('getCover', { workId });
  assert.equal(calls.filter((c) => c.method === 'detail').length, 0);
  assert.equal((await invoke('getWork', { workId })).result.description, 'Description');
  now++;
  cover = 'https://example.org/updated.jpg';
  failDetail = true;
  await invoke('listWorks');
  assert.equal((await invoke('getWork', { workId })).result.description, 'Description');
  await invoke('getCover', { workId });
  assert.equal(calls.filter((c) => c.method === 'detail').length, 1);
  assert.equal(calls.filter((c) => c.method === 'cover').at(-1).input.url, cover);
  now += 600001;
  await assert.rejects(invoke('getWork', { workId }), /upstream_offline/);
});

test(
  'concurrent detail readers share one fetch; list updates cannot overwrite its cache',
  { timeout: 5000 },
  async (t) => {
    const { invoke, tools, calls } = await fixture(t);
    const base = tools.worker;
    let releaseDetail, started;
    const waiting = new Promise((resolve) => {
      started = resolve;
    });
    tools.worker = (...args) => {
      const worker = base(...args),
        original = worker.request;
      worker.request = async (method, input) => {
        if (method === 'detail') {
          started();
          await new Promise((resolve) => {
            releaseDetail = resolve;
          });
        }
        return original(method, input);
      };
      return worker;
    };
    const workId = (await invoke('listWorks')).result.items[0].id;
    const first = invoke('getWork', { workId });
    await waiting;
    const second = invoke('getWork', { workId });
    await invoke('listWorks');
    releaseDetail();
    const results = await Promise.all([first, second]);
    assert.equal(results[0].result.description, 'Description');
    assert.equal(results[1].result.description, 'Description');
    await invoke('getWork', { workId });
    assert.equal(calls.filter((c) => c.method === 'detail').length, 1);
  },
);

test(
  'cancelling one detail reader preserves the other and an activation change invalidates covers',
  { timeout: 5000 },
  async (t) => {
    const { invoke, catalog, source, store, tools } = await fixture(t);
    const base = tools.worker;
    let finish,
      started,
      detailCalls = 0;
    const startedPromise = new Promise((resolve) => {
      started = resolve;
    });
    tools.worker = (...args) => {
      const worker = base(...args),
        original = worker.request;
      worker.request = async (method, input, signal) => {
        if (method === 'detail') {
          detailCalls++;
          if (detailCalls === 1) {
            started();
            await new Promise((resolve) => {
              finish = resolve;
            });
            assert.equal(signal.aborted, false);
          }
          return { title: 'Detailed work', cover: `https://example.org/detail-${detailCalls}.jpg` };
        }
        return original(method, input, signal);
      };
      return worker;
    };
    const workId = (await invoke('listWorks')).result.items[0].id;
    const first = new AbortController();
    const cancelled = catalog.invoke(source, 'source.getWork', { workId }, first.signal);
    const rejected = assert.rejects(cancelled, /cancelled/);
    await startedPromise;
    const secondSignal = new AbortController().signal;
    const listen = secondSignal.addEventListener.bind(secondSignal);
    const joined = new Promise((resolve) => {
      t.mock.method(secondSignal, 'addEventListener', (...args) => {
        listen(...args);
        resolve();
      });
    });
    const second = catalog.invoke(source, 'source.getWork', { workId }, secondSignal);
    await joined;
    first.abort(new Error('cancelled'));
    await rejected;
    finish();
    await second;
    assert.equal(detailCalls, 1);
    store.snapshot().packages[0].activation = 'new-settings';
    await catalog.refresh();
    const cover = await invoke('getCover', { workId });
    assert.ok(cover.result);
    assert.equal(detailCalls, 2);
  },
);

test('filter and browse-mode changes reach the worker and cannot reuse another cached page', async (t) => {
  const { invoke, calls } = await fixture(t, 501);
  const filters = [{ position: 0, value: 1 }];
  const first = (await invoke('listWorks', { filters, browseMode: 'search' })).result;
  assert.deepEqual(calls[0].input.filters, filters);
  assert.equal(calls[0].input.mode, 'search');
  const implicit = (await invoke('listWorks', { filters })).result;
  await assert.rejects(invoke('listWorks', { cursor: implicit.nextCursor, filters, browseMode: 'popular' }), /cursor/);
  await assert.rejects(
    invoke('listWorks', { cursor: first.nextCursor, filters: [{ position: 0, value: 0 }], browseMode: 'search' }),
    /cursor/,
  );
  await assert.rejects(invoke('listWorks', { cursor: first.nextCursor, filters, browseMode: 'latest' }), /cursor/);
  assert.equal(
    (await invoke('listWorks', { cursor: first.nextCursor, filters, browseMode: 'search' })).result.items.length,
    1,
  );
});
