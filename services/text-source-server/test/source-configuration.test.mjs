import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfiguredSources, configuredSourcesFromEnvironment } from '../src/source-configuration.mjs';
import { SourceError } from '../src/catalog.mjs';

const provider = {
  contentProviderEndpoint: 'http://127.0.0.1:1',
  contentProviderKey: 'synthetic-unused-provider-key',
};

const sourceAdapterFactories = new Map([
  [
    'fixture-source',
    async (source, contentProvider) => {
      if (Object.keys(source).some((key) => key !== 'id')) throw new SourceError(500, 'invalid_source_configuration');
      if (!contentProvider) throw new SourceError(503, 'content_provider_not_configured');
      return { id: source.id };
    },
  ],
]);

test('source configuration defaults to no remote adapters and the bundled job protocol', async () => {
  for (const configured of [await createConfiguredSources(), await configuredSourcesFromEnvironment({})]) {
    assert.equal(configured.contentProvider, undefined);
    assert.deepEqual(configured.additionalAdapters, []);
    assert.equal(typeof configured.dispose, 'function');
    await configured.dispose();
  }
  const configured = await createConfiguredSources(provider);
  assert.equal(typeof configured.contentProvider, 'function');
  assert.deepEqual(configured.additionalAdapters, []);
  await assert.rejects(createConfiguredSources({ ...provider, contentProviderProtocol: 'unknown-protocol' }), {
    code: 'unsupported_content_provider_protocol',
  });
});

test('browser metadata transport is explicit, lazy, disposable and rejects executable channel configuration', async () => {
  const configured = await configuredSourcesFromEnvironment({
    SOURCE_HTTP_TRANSPORT: 'browser',
    SOURCE_BROWSER_CHANNEL: 'msedge',
  });
  assert.deepEqual(configured.additionalAdapters, []);
  await configured.dispose(); // Never launches a browser when no request is made.
  await configured.dispose();
  for (const environment of [
    { SOURCE_HTTP_TRANSPORT: 'unknown' },
    { SOURCE_BROWSER_CHANNEL: 'msedge' },
    { SOURCE_HTTP_TRANSPORT: 'browser', SOURCE_BROWSER_CHANNEL: '/private/browser.exe' },
  ])
    await assert.rejects(configuredSourcesFromEnvironment(environment), { code: 'invalid_source_http_transport' });
});

test('source configuration composes only code-injected trusted factories', async () => {
  const sourceAdapters = [{ id: 'fixture-source' }];
  await assert.rejects(createConfiguredSources({ sourceAdapters }), { code: 'invalid_source_configuration' });
  await assert.rejects(createConfiguredSources({ sourceAdapterFactories, sourceAdapters }), {
    code: 'content_provider_not_configured',
    status: 503,
  });
  const configured = await createConfiguredSources({ ...provider, sourceAdapterFactories, sourceAdapters });
  assert.equal(typeof configured.contentProvider, 'function');
  assert.deepEqual(
    configured.additionalAdapters.map((adapter) => adapter.id),
    ['fixture-source'],
  );
  await configured.dispose();
  for (const invalid of [{}, new Map([['fixture-source', 'executable-path']])])
    await assert.rejects(createConfiguredSources({ sourceAdapterFactories: invalid }), {
      code: 'invalid_source_registry',
    });
});

test('unknown, duplicate, malformed and executable source configuration is rejected', async () => {
  for (const sourceAdapters of [
    null,
    {},
    [null],
    [{ id: 'unknown-source', origin: 'auto' }],
    [{ id: 'fixture-source', module: 'https://private.example/module.mjs' }],
    [{ id: 'fixture-source' }, { id: 'fixture-source' }],
  ]) {
    await assert.rejects(createConfiguredSources({ ...provider, sourceAdapters, sourceAdapterFactories }), {
      code: 'invalid_source_configuration',
    });
  }
});

test('environment composition accepts generic settings and redacts malformed JSON', async () => {
  assert.throws(() => configuredSourcesFromEnvironment({ SOURCE_ADAPTERS: '{private malformed' }), {
    code: 'invalid_source_configuration',
    message: 'invalid_source_configuration',
  });
  await assert.rejects(configuredSourcesFromEnvironment({ SOURCE_ADAPTERS: '{}' }), {
    code: 'invalid_source_configuration',
  });
  await assert.rejects(configuredSourcesFromEnvironment({ CONTENT_PROVIDER_PROTOCOL: 'unknown' }), {
    code: 'unsupported_content_provider_protocol',
  });
  const configured = await configuredSourcesFromEnvironment(
    {
      CONTENT_PROVIDER_ENDPOINT: provider.contentProviderEndpoint,
      CONTENT_PROVIDER_KEY: provider.contentProviderKey,
      CONTENT_PROVIDER_PROTOCOL: 'job-v1',
      SOURCE_ADAPTERS: JSON.stringify([{ id: 'fixture-source' }]),
    },
    { sourceAdapterFactories },
  );
  assert.equal(typeof configured.contentProvider, 'function');
  assert.deepEqual(
    configured.additionalAdapters.map((adapter) => adapter.id),
    ['fixture-source'],
  );
});
