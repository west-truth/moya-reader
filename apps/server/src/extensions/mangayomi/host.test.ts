import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerAuthHook } from '../../auth.js';
import type { ServerConfig } from '../../config.js';
import { registerApkExtensionRoutes } from '../../routes/apk-extensions.js';
import { registerExtensionPackageRoutes } from '../../routes/extension-packages.js';
import { IndexedDbPackageInstallStore } from '../../../../../src/extensions/packages/package-install-store.js';
import { createNodePackageExecution } from '../node-package-execution.js';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MangayomiExtensionHost } from './host.js';
import { EncryptedSourceCredentialVault } from '../source-credential-vault.js';
import { fixtureRow, fixtureSource } from './test-fixture.js';
import type { compatibilityHttp } from './http.js';
import { dispatchApkCommand } from '../apk-command.js';
import { OUTBOUND_PROXY_KEY } from '../outbound-proxy.js';
const roots: string[] = [];
const hosts: MangayomiExtensionHost[] = [];
it('installs a novel repository and returns cleaned UTF-8 chapters instead of image pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moya-mangayomi-novel-'));
  roots.push(root);
  const row = { ...fixtureRow, itemType: 2, isManga: false };
  const script =
    fixtureSource +
    `
    DefaultExtension.prototype.getHtmlContent=async function(name,url){
      if(name!=='One'||url!=='/1')throw new Error('wrong chapter');
      return '<h2>제1화</h2><p>첫 &amp; 문장<br>다음 줄</p><p>둘째 <b>문장</b></p><script>untrusted()</script>';
    };
    DefaultExtension.prototype.cleanHtmlContent=async function(html){return html.replace('둘째','마지막');};
    DefaultExtension.prototype.getPageList=function(){throw new Error('not manga');};`;
  const host = await MangayomiExtensionHost.open(
    join(root, 'host'),
    new EncryptedSourceCredentialVault(join(root, 'vault'), Buffer.alloc(32, 3)),
    async (input) => ({
      bytes: Buffer.from(input.url.endsWith('.json') ? JSON.stringify([row]) : script),
      statusCode: 200,
      headers: {},
      contentType: 'text/plain',
      url: input.url,
    }),
  );
  hosts.push(host);
  const signal = new AbortController().signal;
  const repo = 'https://repo.example/index.min.json';
  await host.refreshRepository(repo, signal);
  const pkg = host.snapshot().repositories[0].entries[0];
  const review = await host.inspect(repo, pkg.pkg, pkg.code, signal);
  await host.install(review.id, review.revision, signal);
  const descriptor = host.catalog.getSources()[0].descriptor;
  expect(descriptor.seriesProfile).toMatchObject({ kind: 'document_series', format: 'txt' });
  const works = await host.catalog.invoke(descriptor.id, 'source.listWorks', {}, signal);
  const workId = works.result.items[0].id;
  const releases = await host.catalog.invoke(descriptor.id, 'source.listReleases', { workId }, signal);
  const content = await host.catalog.invoke(
    descriptor.id,
    'source.getContent',
    { workId, releaseId: releases.result.items[0].id },
    signal,
  );
  expect(content.result.kind).toBe('text');
  if (content.result.kind !== 'text') throw new Error('wrong content');
  expect(await content.assets.get(content.result.asset.handle)?.text()).toBe(
    '제1화\n\n첫 & 문장\n다음 줄\n\n마지막 문장',
  );
});
afterEach(async () => {
  hosts.splice(0).forEach((h) => h.close());
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it('does not retain review slots when cancellation arrives with the downloaded script', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moya-mangayomi-cancel-'));
  roots.push(root);
  let abort: AbortController | undefined;
  const transport: typeof compatibilityHttp = async (input) => {
    const script = input.url.endsWith('.js');
    if (script) abort?.abort();
    return {
      bytes: Buffer.from(script ? fixtureSource : JSON.stringify([fixtureRow])),
      statusCode: 200,
      headers: {},
      contentType: 'text/plain',
      url: input.url,
    };
  };
  const host = await MangayomiExtensionHost.open(
    join(root, 'host'),
    new EncryptedSourceCredentialVault(join(root, 'vault'), Buffer.alloc(32, 8)),
    transport,
  );
  hosts.push(host);
  const repo = 'https://repo.example/index.min.json';
  await host.refreshRepository(repo, new AbortController().signal);
  const pkg = host.snapshot().repositories[0].entries[0];
  for (let index = 0; index < 6; index++) {
    abort = new AbortController();
    await expect(host.inspect(repo, pkg.pkg, pkg.code, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  }
  abort = undefined;
  const review = await host.inspect(repo, pkg.pkg, pkg.code, new AbortController().signal);
  expect(review.pkg).toBe(pkg.pkg);
});
it('preserves encrypted options across restart and imports original-script pages through the common image contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moya-mangayomi-'));
  roots.push(root);
  const vaultPath = join(root, 'vault'),
    key = Buffer.alloc(32, 27);
  const vault = new EncryptedSourceCredentialVault(vaultPath, key);
  const calls: string[] = [];
  let version = '1.0.0';
  const transport: typeof compatibilityHttp = async (input, _signal, privateOrigins, _maximum, proxy) => {
    calls.push(input.url);
    let bytes: Buffer<ArrayBuffer>;
    if (input.url.endsWith('.json')) bytes = Buffer.from(JSON.stringify([{ ...fixtureRow, version }]));
    else if (input.url.endsWith('.js')) bytes = Buffer.from(fixtureSource + `\n// version ${version}`);
    else if (input.url.endsWith('.jpg')) {
      expect(proxy).toBe('socks5://127.0.0.1:40000');
      expect(input.headers?.Referer).toBe('https://site.example/1');
      bytes = Buffer.from([255, 216, 255, 217]);
    } else {
      expect(privateOrigins).toEqual(['http://127.0.0.1:9870']);
      if (input.url.endsWith('/jobs')) expect(input.headers?.Authorization).toBe('Bearer secret-fixture-key');
      bytes = Buffer.from('{}');
    }
    return {
      bytes,
      statusCode: 200,
      headers: {},
      contentType: input.url.endsWith('.jpg') ? 'image/jpeg' : 'application/json',
      url: input.url,
    };
  };
  let host = await MangayomiExtensionHost.open(join(root, 'host'), vault, transport);
  hosts.push(host);
  const signal = new AbortController().signal,
    repo = 'https://repo.example/index.min.json';
  await host.refreshRepository(repo, signal);
  await host.refreshRepository('https://second.example/index.min.json', signal);
  expect(host.snapshot().repositories).toHaveLength(2);
  const pkg = host.snapshot().repositories[0].entries[0];
  for (let index = 0; index < 6; index++) {
    const dismissed = await host.inspect(repo, pkg.pkg, pkg.code, signal);
    await dispatchApkCommand(host, { action: 'discard', id: dismissed.id }, signal);
    await expect(host.install(dismissed.id, dismissed.revision, signal)).rejects.toThrow('apk_review_expired');
  }
  const review = await host.inspect(repo, pkg.pkg, pkg.code, signal);
  expect(host.snapshot().packages).toHaveLength(0);
  await expect(
    dispatchApkCommand(host, { action: 'install', id: review.id, revision: review.revision }, signal),
  ).rejects.toThrow('apk_input_invalid');
  await host.install(review.id, review.revision, signal);
  await expect(host.savePreferences(pkg.pkg, host.snapshot().revision, { enabled: 'false' }, [])).rejects.toThrow(
    'compatibility_preferences_invalid',
  );
  await host.savePreferences(
    pkg.pkg,
    host.snapshot().revision,
    {
      enabled: true,
      endpoint: 'http://127.0.0.1:9870',
      access_key: 'secret-fixture-key',
      [OUTBOUND_PROXY_KEY]: 'socks5://127.0.0.1:40000',
    },
    ['http://127.0.0.1:9870'],
  );
  expect(host.preferences(pkg.pkg).fields.find((f) => f.key === 'access_key')).toMatchObject({
    configured: true,
    value: undefined,
  });
  expect(JSON.stringify(host.snapshot()) + JSON.stringify(host.preferences(pkg.pkg))).not.toContain(
    'secret-fixture-key',
  );
  for (const file of await readdir(vaultPath))
    expect((await readFile(join(vaultPath, file))).includes(Buffer.from('secret-fixture-key'))).toBe(false);
  host.close();
  host = await MangayomiExtensionHost.open(
    join(root, 'host'),
    new EncryptedSourceCredentialVault(vaultPath, key),
    transport,
  );
  hosts.push(host);
  const source = host.catalog.getSources()[0].descriptor.id;
  expect(host.preferences(pkg.pkg).fields.find((field) => field.key === OUTBOUND_PROXY_KEY)?.value).toBe(
    'socks5://127.0.0.1:40000',
  );
  const listing = await host.catalog.invoke(source, 'source.listWorks', {}, signal);
  const work = listing.result.items[0];
  const releases = await host.catalog.invoke(source, 'source.listReleases', { workId: work.id }, signal);
  const rows = releases.result.items;
  expect(rows.map((r) => r.title)).toEqual(['One', 'Two']);
  const downloaded = await host.catalog.invoke(
    source,
    'source.getContent',
    { workId: work.id, releaseId: rows[0].id },
    signal,
  );
  expect(downloaded.result).toMatchObject({ kind: 'images' });
  expect(downloaded.assets.size).toBe(1);
  expect(calls).toContain('http://127.0.0.1:9870/close');
  const app = Fastify();
  const headers = { authorization: 'Bearer fixture-auth' };
  await registerAuthHook(app, { host: '127.0.0.1', authToken: 'fixture-auth' } as ServerConfig);
  await registerApkExtensionRoutes(app, host, '/api/mangayomi-extensions');
  await registerExtensionPackageRoutes(
    app,
    new IndexedDbPackageInstallStore(`mg-${crypto.randomUUID()}`),
    createNodePackageExecution(),
    undefined,
    host,
  );
  try {
    expect((await app.inject('/api/mangayomi-extensions')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/mangayomi-extensions/preferences',
          headers,
          payload: { pkg: pkg.pkg },
        })
      )
        .json()
        .fields.find((f: { key: string }) => f.key === 'access_key').value,
    ).toBeUndefined();
    const prefix = '/api/extensions/sources/' + encodeURIComponent(source);
    const chapters = (
      await app.inject({ method: 'POST', url: prefix + '/list', headers, payload: { parentRef: work.id } })
    ).json().items;
    const cbz = await app.inject({
      method: 'POST',
      url: prefix + '/download',
      headers,
      payload: { key: chapters[0].key, fileName: chapters[0].importFileName },
    });
    expect(cbz.statusCode).toBe(200);
    expect(cbz.rawPayload.subarray(0, 2).toString()).toBe('PK');
  } finally {
    await app.close();
  }
  // Route shutdown disposes the host; reopen durable state for update checks.
  host = await MangayomiExtensionHost.open(join(root, 'host'), vault, transport);
  hosts.push(host);
  version = '0.9.0';
  await host.refreshRepository(repo, signal);
  await expect(
    host.inspect(repo, pkg.pkg, host.snapshot().repositories.find((r) => r.url === repo)!.entries[0].code, signal),
  ).rejects.toThrow('apk_version_not_newer');
  version = '1.1.0';
  await host.refreshRepository(repo, signal);
  const update = await host.inspect(
    repo,
    pkg.pkg,
    host.snapshot().repositories.find((r) => r.url === repo)!.entries[0].code,
    signal,
  );
  await host.install(update.id, update.revision, signal);
  expect(host.preferences(pkg.pkg).fields.find((f) => f.key === 'access_key')?.configured).toBe(true);
  await host.change(pkg.pkg, host.snapshot().revision, 'disable');
  expect(host.catalog.getSources()).toHaveLength(0);
  await host.change(pkg.pkg, host.snapshot().revision, 'enable');
  expect(host.catalog.getSources()).toHaveLength(1);
  await host.change(pkg.pkg, host.snapshot().revision, 'remove');
  expect(await readdir(vaultPath)).toHaveLength(0);
});

it('imports original JS files without a repository, preserves multi-source choice and review cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moya-file-import-'));
  roots.push(root);
  const host = await MangayomiExtensionHost.open(
    join(root, 'host'),
    new EncryptedSourceCredentialVault(join(root, 'vault'), Buffer.alloc(32, 6)),
    async () => {
      throw new Error('unexpected_network');
    },
  );
  hosts.push(host);
  const source = Buffer.from(
    `const mangayomiSources=${JSON.stringify([
      { ...fixtureRow, name: 'First' },
      { ...fixtureRow, name: 'Second', lang: 'en' },
    ])};` + fixtureSource,
  );
  const signal = AbortSignal.timeout(10000);
  const review = await host.inspectFile(source, 'extension.js', 1, signal);
  expect(review.fileSources).toHaveLength(2);
  await host.install(review.id, review.revision, signal);
  expect(host.catalog.getSources()[0].descriptor.title).toBe('Second');
  expect(host.snapshot().repositories).toHaveLength(0);
  await expect(host.inspectFile(source, 'extension.js', 1, signal)).rejects.toThrow('apk_version_not_newer');
  const app = Fastify();
  await registerApkExtensionRoutes(app, host, '/api/mangayomi-extensions');
  const request = { name: 'extension.js', base64: source.toString('base64'), sourceIndex: 0 };
  const uploaded = await app.inject({
    method: 'POST',
    url: '/api/mangayomi-extensions/inspect-file',
    payload: request,
  });
  expect(uploaded.statusCode).toBe(200);
  host.discard(uploaded.json().id);
  const native = await dispatchApkCommand(host, { action: 'inspect-file', ...request }, signal);
  expect(native.kind).toBe('json');
  if (native.kind === 'json') host.discard((native.value as { id: string }).id);
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/mangayomi-extensions/inspect-file',
    payload: { ...request, name: '../bad.js' },
  });
  expect(invalid.statusCode).toBe(422);
  const cancelled = await host.inspectFile(source, 'extension.js', 0, signal);
  host.discard(cancelled.id);
  await expect(host.install(cancelled.id, cancelled.revision, signal)).rejects.toThrow('apk_review_expired');
  await expect(host.inspectFile(Buffer.from('process.exit()'), 'bad.js', 0, signal)).rejects.toThrow();
  await app.close();
});
