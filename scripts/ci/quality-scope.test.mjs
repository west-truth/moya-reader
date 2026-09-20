import assert from 'node:assert/strict';
import test from 'node:test';
import { qualityScope } from './quality-scope.mjs';

test('reader-only changes keep browser coverage without Docker or Windows', () => {
  const result = qualityScope(['src/features/reader/PaginatedReaderViewport.tsx']);
  assert.equal(result.code && result.web && result.reader, true);
  for (const key of ['deploy', 'native', 'settings', 'discovery', 'extensions']) assert.equal(result[key], false, key);
});

test('documentation is skipped, while build/dependency/unknown changes and full runs fail open', () => {
  assert.equal(Object.values(qualityScope(['docs/operations/update.md'])).some(Boolean), false);
  for (const files of [
    ['pnpm-lock.yaml'],
    ['deploy/server.Dockerfile', 'package.json'],
    ['new-runtime/entry.ts'],
    ['scripts/ci/quality-scope.mjs'],
  ]) {
    assert.equal(Object.values(qualityScope(files)).every(Boolean), true);
  }
  assert.equal(Object.values(qualityScope([], true)).every(Boolean), true);
});

test('native changes and hosted deployment changes select their own heavy gates', () => {
  assert.equal(qualityScope(['src-tauri/src/lib.rs']).native, true);
  assert.equal(qualityScope(['src-tauri/src/lib.rs']).web, false);
  for (const file of [
    'deploy/web.Dockerfile',
    '.dockerignore',
    'compose.yaml',
    'apps/server/src/db/migrations/001.sql',
    'apps/server/build.mjs',
  ]) {
    assert.equal(qualityScope([file]).deploy, true, file);
  }
});

test('shared UI state runs all browser regressions and source backends keep the app gate', () => {
  const shared = qualityScope(['src/storage/reader-settings-store.ts']);
  for (const key of ['web', 'reader', 'settings', 'discovery', 'extensions']) assert.equal(shared[key], true, key);
  assert.equal(qualityScope(['apps/server/src/extensions/mangayomi/host.ts']).extensions, true);
  assert.equal(qualityScope(['services/apk-worker/catalog.mjs']).apk, true);
  assert.equal(qualityScope(['services/text-source-server/index.mjs']).text, true);
});
