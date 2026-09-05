import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { initializeSourceServer, formatInitialization } from './init.mjs';
import { diagnoseSourceServer, formatDiagnostics } from './check.mjs';

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'moya-source-setup-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('moya-source-setup-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function initialized(t) {
  const directory = await temporary(t);
  const result = await initializeSourceServer({ directory });
  assert.equal(result.ok, true);
  const environment = parseEnv(await readFile(path.join(directory, '.env'), 'utf8'));
  return { directory, environment, result };
}

test('init creates generic local defaults with private random keys and stable identity', async (t) => {
  const { directory, environment, result } = await initialized(t);
  assert.match(environment.SERVER_KEY, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(environment.CATALOG_FILE, './data/catalog.json');
  assert.equal(environment.SOURCE_ROOT, './data/content');
  assert.equal(environment.SOURCE_ADAPTERS, '[]');
  assert.equal(environment.CONTENT_PROVIDER_ENDPOINT, '');
  assert.equal(environment.CONTENT_PROVIDER_KEY, '');
  assert.equal(environment.CONTENT_PROVIDER_PROTOCOL, 'job-v1');
  const catalog = JSON.parse(await readFile(path.join(directory, 'data/catalog.json'), 'utf8'));
  assert.match(catalog.instanceId, /^text-server-[a-f0-9-]{36}$/u);
  assert.match(catalog.dataNamespace, /^library-[a-f0-9-]{36}$/u);
  assert.deepEqual(catalog.sources, []);
  assert.equal(formatInitialization(result).includes(environment.SERVER_KEY), false);
  const other = await initialized(t);
  assert.notEqual(other.environment.SERVER_KEY, environment.SERVER_KEY);
});

test('init preserves existing credentials, catalog and content byte for byte', async (t) => {
  const { directory, environment } = await initialized(t);
  const originalEnv = await readFile(path.join(directory, '.env'));
  const originalCatalog = await readFile(path.join(directory, 'data/catalog.json'));
  const originalBody = Buffer.from('\ufeffPreserved fixture.\r\n');
  await writeFile(path.join(directory, 'data/content/existing.txt'), originalBody);
  const second = await initializeSourceServer({ directory });
  assert.equal(second.ok, true);
  assert.deepEqual(second.created, []);
  assert.deepEqual(await readFile(path.join(directory, '.env')), originalEnv);
  assert.deepEqual(await readFile(path.join(directory, 'data/catalog.json')), originalCatalog);
  assert.deepEqual(await readFile(path.join(directory, 'data/content/existing.txt')), originalBody);
  assert.equal(formatInitialization(second).includes(environment.SERVER_KEY), false);
});

test('init reports partial creation and a conflicting target without deleting existing items', async (t) => {
  const directory = await temporary(t);
  await mkdir(path.join(directory, 'data'));
  await mkdir(path.join(directory, 'data/catalog.json'));
  await writeFile(path.join(directory, 'data/catalog.json/keep'), 'Existing fixture.');
  const result = await initializeSourceServer({ directory });
  assert.equal(result.ok, false);
  assert.equal(result.failed, 'data/catalog.json');
  assert.deepEqual(result.created, ['data/content/']);
  assert.equal(await readFile(path.join(directory, 'data/catalog.json/keep'), 'utf8'), 'Existing fixture.');
  assert.match(formatInitialization(result), /일부 실패/u);
  assert.match(formatInitialization(result), /다시 실행/u);
});

test('check diagnoses first-run defaults without any network or body request', async (t) => {
  const fixture = await initialized(t);
  let calls = 0;
  const result = await diagnoseSourceServer({
    ...fixture,
    fetchImpl: async () => {
      calls += 1;
      throw new Error();
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 0);
  assert.ok(result.checks.some((check) => check.code === 'sources' && check.status === 'warning'));
  assert.ok(result.checks.some((check) => check.code === 'provider_health' && check.status === 'warning'));
  assert.equal(formatDiagnostics(result).includes(fixture.environment.SERVER_KEY), false);
  const command = fileURLToPath(new URL('./check.mjs', import.meta.url));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--env-file-if-exists=.env', command], {
    cwd: fixture.directory,
    // Do not inherit a developer's provider endpoint/key or override the synthetic .env.
    env: { SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir() },
  });
  assert.match(stdout, /서버 접속 키 형식을 확인/u);
  assert.equal(stdout.includes(fixture.environment.SERVER_KEY), false);
  assert.equal(stderr, '');
});

test('check makes only authenticated provider health and ignores vendor identity in its output', async (t) => {
  const fixture = await initialized(t);
  const endpoint = 'https://private-provider.example';
  const key = 'synthetic-private-provider-key';
  const calls = [];
  const result = await diagnoseSourceServer({
    ...fixture,
    environment: { ...fixture.environment, CONTENT_PROVIDER_ENDPOINT: endpoint, CONTENT_PROVIDER_KEY: key },
    fetchImpl: async (url, options) => {
      calls.push({ pathname: url.pathname, method: options.method });
      assert.equal(options.headers.Authorization, `Bearer ${key}`);
      return Response.json({ protocol: 1, ready: true, service: 'private-vendor', version: 'private-version' });
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ pathname: '/health', method: 'GET' }]);
  const output = formatDiagnostics(result);
  for (const secret of [endpoint, key, fixture.environment.SERVER_KEY, 'private-vendor', 'private-version'])
    assert.equal(output.includes(secret), false);
});

test('check rejects unready or incompatible health and reports authentication and timeout actions safely', async (t) => {
  const fixture = await initialized(t);
  const environment = {
    ...fixture.environment,
    CONTENT_PROVIDER_ENDPOINT: 'https://provider.example',
    CONTENT_PROVIDER_KEY: 'fixture-key',
  };
  for (const [body, status, code] of [
    [{ protocol: 2, ready: true }, 200, 'provider_protocol'],
    [{ protocol: 1, ready: false }, 200, 'provider_ready'],
    [{ privateError: 'private response' }, 401, 'provider_health'],
  ]) {
    const result = await diagnoseSourceServer({
      ...fixture,
      environment,
      fetchImpl: async () => Response.json(body, { status }),
    });
    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check) => check.code === code && check.status === 'fail'));
    assert.equal(formatDiagnostics(result).includes('private response'), false);
  }
  const timeout = await diagnoseSourceServer({
    ...fixture,
    environment,
    timeoutMs: 20,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  });
  assert.equal(timeout.ok, false);
  assert.match(formatDiagnostics(timeout), /응답 시간이 초과/u);
});

test('check reports invalid source configuration and missing provider without making body requests', async (t) => {
  const fixture = await initialized(t);
  const fetchImpl = async () => {
    throw new Error('Unexpected network');
  };
  const invalid = await diagnoseSourceServer({
    ...fixture,
    environment: { ...fixture.environment, SOURCE_ADAPTERS: 'invalid JSON' },
    fetchImpl,
  });
  assert.equal(invalid.ok, false);
  assert.match(formatDiagnostics(invalid), /JSON 배열/u);
  const catalogFile = path.join(fixture.directory, 'data/catalog.json');
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  catalog.sources = [
    {
      id: 'fixture',
      name: 'Fixture',
      works: [
        {
          id: 'work',
          title: 'Work',
          releases: [{ id: 'one', title: 'One', order: 1, contentUrl: 'https://source.example/work/one' }],
        },
      ],
    },
  ];
  await writeFile(catalogFile, JSON.stringify(catalog));
  const missing = await diagnoseSourceServer({ ...fixture, fetchImpl });
  assert.equal(missing.ok, false);
  assert.ok(missing.checks.some((check) => check.code === 'catalog_provider' && check.status === 'fail'));
});
