import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApkInstallations, apkStateDirectory } from './installations.mjs';

const metadata = (code = 1, signer = 'a') => ({
  pkg: 'org.example.manga',
  entry: 'org.example.manga.Factory',
  code,
  version: `1.4.${code}`,
  signers: [signer.repeat(64)],
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'moya-apk-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { value: metadata(), fail: false, conversions: 0 };
  const tools = {
    inspect: async () => config.value,
    convert: async () => {
      config.conversions++;
    },
    describe: async () => {
      if (config.fail) throw new Error('compatibility_failed');
      return [{ id: '123', name: 'Novel images', lang: 'ko' }];
    },
  };
  return { root, config, tools, store: await new ApkInstallations(root, tools).open() };
}
test('review executes no APK and install survives host restart', async (t) => {
  const { root, config, tools, store } = await fixture(t);
  const review = await store.inspect(Buffer.from('apk fixture'), config.value);
  assert.equal(config.conversions, 0);
  assert.equal(store.snapshot().packages.length, 0);
  await store.install(review.id, review.revision);
  const reopened = await new ApkInstallations(root, tools).open();
  assert.equal(reopened.snapshot().packages[0].sources[0].name, 'Novel images');
});
test('failed updates keep the active version and mismatched signatures never execute', async (t) => {
  const { store, config } = await fixture(t);
  let plan = await store.inspect(Buffer.from('one version'), config.value);
  await store.install(plan.id, plan.revision);
  config.value = metadata(2, 'b');
  await assert.rejects(store.inspect(Buffer.from('wrong signer'), config.value), /publisher_changed/);
  assert.equal(config.conversions, 1);
  config.value = metadata(2);
  plan = await store.inspect(Buffer.from('two version'), config.value);
  config.fail = true;
  await assert.rejects(store.install(plan.id, plan.revision), /compatibility_failed/);
  assert.equal(store.snapshot().packages[0].code, 1);
});
test('stale reviews cannot resurrect a removed package', async (t) => {
  const { store, config } = await fixture(t);
  let plan = await store.inspect(Buffer.from('one version'), config.value);
  await store.install(plan.id, plan.revision);
  config.value = metadata(2);
  plan = await store.inspect(Buffer.from('two version'), config.value);
  await store.remove(config.value.pkg, 1);
  await assert.rejects(store.install(plan.id, plan.revision), /install_conflict/);
  assert.equal(store.snapshot().packages.length, 0);
});
test('preference changes fence earlier requests and serialize with removal, including rejected saves', async (t) => {
  const { store, config } = await fixture(t);
  const plan = await store.inspect(Buffer.from('one version'), config.value);
  await store.install(plan.id, plan.revision);
  const before = store.snapshot();
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let finish;
  const waiting = new Promise((resolve) => {
    finish = resolve;
  });
  const save = store.updatePreferences(config.value.pkg, before.revision, async (record) => {
    assert.notEqual(record.activation, before.packages[0].activation);
    entered();
    await waiting;
    throw new Error('preference_rejected');
  });
  const rejected = assert.rejects(save, /preference_rejected/);
  await started;
  const revision = store.snapshot().revision;
  assert.equal(revision, before.revision + 1);
  const remove = store.remove(config.value.pkg, revision);
  assert.equal(store.snapshot().packages.length, 1);
  finish();
  await rejected;
  await remove;
  assert.equal(store.snapshot().packages.length, 0);
  let invoked = false;
  await assert.rejects(
    store.updatePreferences(config.value.pkg, before.revision, async () => {
      invoked = true;
    }),
    /install_conflict/,
  );
  assert.equal(invoked, false);
});
test('updates retain preferences but reinstall does not inherit removed installation state', async (t) => {
  const { root, store, config } = await fixture(t);
  let plan = await store.inspect(Buffer.from('one version'), config.value);
  await store.install(plan.id, plan.revision);
  const initial = apkStateDirectory(root, store.snapshot().packages[0]);
  config.value = metadata(2);
  plan = await store.inspect(Buffer.from('two version'), config.value);
  await store.install(plan.id, plan.revision);
  assert.equal(apkStateDirectory(root, store.snapshot().packages[0]), initial);
  await store.remove(config.value.pkg, store.snapshot().revision);
  config.value = metadata(1, 'b');
  plan = await store.inspect(Buffer.from('another publisher'), config.value);
  await store.install(plan.id, plan.revision);
  assert.notEqual(apkStateDirectory(root, store.snapshot().packages[0]), initial);
});

test('local APK files derive verified identity without an index and retain publisher/update guards', async (t) => {
  const { store, config } = await fixture(t);
  const review = await store.inspect(Buffer.from('local apk'), undefined);
  assert.equal(review.pkg, config.value.pkg);
  await store.install(review.id, review.revision);
  config.value = metadata(2, 'b');
  await assert.rejects(store.inspect(Buffer.from('different publisher'), undefined), /publisher_changed/);
  config.value = metadata(1);
  await assert.rejects(store.inspect(Buffer.from('old version'), undefined), /version_not_newer/);
});
