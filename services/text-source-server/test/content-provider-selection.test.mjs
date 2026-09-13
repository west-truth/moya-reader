import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfiguredSources, configuredSourcesFromEnvironment } from '../src/source-configuration.mjs';

const body = Buffer.from('\ufeff  Synthetic text\r\n\r\nEnd  \r\n');
const legacy = { contentProviderEndpoint: 'http://127.0.0.1:1', contentProviderKey: 'synthetic-legacy-key' };

test('per-source bindings keep legacy default, isolate a named provider and opt out for direct content', async () => {
  let calls = 0;
  const provided = async (url, signal) => {
    assert.equal(url, 'https://source.example/work/chapter');
    assert.ok(signal instanceof AbortSignal);
    signal.throwIfAborted();
    calls++;
    return body;
  };
  const seen = [];
  const sourceAdapterFactories = new Map(
    ['old', 'named', 'direct'].map((id) => [
      id,
      (settings, provider) => {
        seen.push({ settings, provider });
        return { id, provider };
      },
    ]),
  );
  const configured = await createConfiguredSources({
    ...legacy,
    sourceAdapterFactories,
    contentProviders: [{ id: 'remote', protocol: 'synthetic', options: { key: 'synthetic-private-key' } }],
    contentProviderFactories: new Map([
      [
        'synthetic',
        (options) => {
          assert.equal(options.key, 'synthetic-private-key');
          return provided;
        },
      ],
    ]),
    sourceAdapters: [
      { id: 'old' },
      { id: 'named', contentProviderId: 'remote' },
      { id: 'direct', contentProviderId: null },
    ],
  });
  try {
    assert.equal(seen[0].provider, configured.contentProvider);
    assert.equal(seen[1].provider, provided);
    assert.equal(seen[2].provider, undefined);
    assert.deepEqual(
      seen.map((entry) => entry.settings),
      [{ id: 'old' }, { id: 'named' }, { id: 'direct' }],
    );
    const signal = new AbortController().signal;
    assert.equal(await seen[1].provider('https://source.example/work/chapter', signal), body);
    assert.equal(calls, 1);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(seen[1].provider('https://source.example/work/chapter', aborted.signal));
    assert.equal(calls, 1);
  } finally {
    await configured.dispose();
  }
});

test('one named connection is shared, unused drivers never start, and teardown runs once', async () => {
  let opened = 0;
  let closed = 0;
  const sourceAdapterFactories = new Map(['one', 'two'].map((id) => [id, (settings, provider) => ({ id, provider })]));
  const configured = await createConfiguredSources({
    sourceAdapterFactories,
    sourceAdapters: ['one', 'two'].map((id) => ({ id, contentProviderId: 'shared' })),
    contentProviders: ['shared', 'unused'].map((id) => ({ id, protocol: 'fixture', options: { id } })),
    contentProviderFactories: new Map([
      [
        'fixture',
        ({ id }) => {
          assert.equal(id, 'shared');
          opened++;
          return Object.assign(async () => body, {
            dispose: () => {
              closed++;
            },
          });
        },
      ],
    ]),
  });
  assert.equal(configured.contentProvider, undefined);
  assert.equal(configured.additionalAdapters[0].provider, configured.additionalAdapters[1].provider);
  assert.equal(opened, 1);
  await configured.dispose();
  await configured.dispose();
  assert.equal(closed, 1);
});

test('unknown or invalid explicit bindings fail before any driver starts instead of falling back', async () => {
  for (const contentProviderId of ['missing', '', 5, false, {}, 'default']) {
    let starts = 0;
    await assert.rejects(
      createConfiguredSources({
        sourceAdapters: [{ id: 'one', contentProviderId }],
        sourceAdapterFactories: new Map([
          [
            'one',
            () => {
              starts++;
            },
          ],
        ]),
        contentProviders: [{ id: 'remote', protocol: 'fixture', options: {} }],
        contentProviderFactories: new Map([
          [
            'fixture',
            () => {
              starts++;
            },
          ],
        ]),
      }),
      { code: 'content_provider_not_configured' },
    );
    assert.equal(starts, 0);
  }
});

test('teardown closes prior connections after an adapter startup failure and sanitizes factory failures', async () => {
  let closed = 0;
  const options = {
    contentProviders: [{ id: 'remote', protocol: 'fixture', options: {} }],
    sourceAdapters: [{ id: 'one', contentProviderId: 'remote' }],
    sourceAdapterFactories: new Map([
      [
        'one',
        () => {
          throw new Error('adapter failed');
        },
      ],
    ]),
    contentProviderFactories: new Map([
      [
        'fixture',
        () =>
          Object.assign(async () => body, {
            dispose: () => {
              closed++;
            },
          }),
      ],
    ]),
  };
  await assert.rejects(createConfiguredSources(options), /adapter failed/);
  assert.equal(closed, 1);
  for (const factory of [
    () => {
      throw new Error('secret endpoint/key');
    },
    () => ({}),
  ])
    await assert.rejects(
      createConfiguredSources({ ...options, contentProviderFactories: new Map([['fixture', factory]]) }),
      {
        code: 'invalid_content_provider_configuration',
        message: 'invalid_content_provider_configuration',
      },
    );
});

test('provider definitions are data only, cannot replace built-ins and redact malformed environment', async () => {
  for (const contentProviders of [
    null,
    {},
    [null],
    [{ id: 'default', protocol: 'job-v1', options: {} }],
    [{ id: 'remote', protocol: 'job-v1', options: {}, module: 'https://private.example/plugin.mjs' }],
    Array.from({ length: 33 }, (_, i) => ({ id: `p${i}`, protocol: 'job-v1', options: {} })),
    [
      { id: 'remote', protocol: 'job-v1', options: {} },
      { id: 'remote', protocol: 'job-v1', options: {} },
    ],
  ])
    await assert.rejects(createConfiguredSources({ contentProviders }), {
      code: 'invalid_content_provider_configuration',
    });
  for (const contentProviderFactories of [{}, new Map([['job-v1', () => {}]]), new Map([['other', 'module.mjs']])])
    await assert.rejects(createConfiguredSources({ contentProviderFactories }), {
      code: 'invalid_content_provider_registry',
    });
  for (const raw of ['{private secret', ' '.repeat(65537)])
    assert.throws(() => configuredSourcesFromEnvironment({ CONTENT_PROVIDERS: raw }), {
      code: 'invalid_content_provider_configuration',
      message: 'invalid_content_provider_configuration',
    });
  await assert.rejects(
    createConfiguredSources({ contentProviders: [{ id: 'remote', protocol: 'unknown', options: {} }] }),
    {
      code: 'unsupported_content_provider_protocol',
    },
  );
});

test('environment accepts named connections without changing existing endpoint or requiring a provider for direct sources', async () => {
  const seen = [];
  const configured = await configuredSourcesFromEnvironment(
    {
      CONTENT_PROVIDER_ENDPOINT: legacy.contentProviderEndpoint,
      CONTENT_PROVIDER_KEY: legacy.contentProviderKey,
      CONTENT_PROVIDERS: JSON.stringify([
        {
          id: 'remote',
          protocol: 'job-v1',
          options: {
            endpoint: 'http://127.0.0.1:2',
            key: 'synthetic-second-key',
          },
        },
      ]),
      SOURCE_ADAPTERS: JSON.stringify([{ id: 'one', contentProviderId: 'remote' }]),
    },
    {
      sourceAdapterFactories: new Map([
        [
          'one',
          (settings, provider) => {
            seen.push(provider);
            return settings;
          },
        ],
      ]),
    },
  );
  assert.equal(typeof seen[0], 'function');
  assert.notEqual(seen[0], configured.contentProvider);
  await configured.dispose();
  const direct = await createConfiguredSources({
    sourceAdapters: [{ id: 'direct', contentProviderId: null }],
    sourceAdapterFactories: new Map([
      [
        'direct',
        (settings, provider) => {
          assert.equal(provider, undefined);
          return settings;
        },
      ],
    ]),
  });
  assert.equal(direct.contentProvider, undefined);
  await direct.dispose();
});
