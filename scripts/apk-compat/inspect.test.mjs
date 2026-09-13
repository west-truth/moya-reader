import assert from 'node:assert/strict';
import test from 'node:test';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';
import { inspectApk, inspectDex } from './inspect.mjs';

function dex(types, definitions = []) {
  const stringStart = 112,
    typeStart = stringStart + types.length * 4,
    classStart = typeStart + types.length * 4;
  const dataStart = classStart + definitions.length * 32;
  const bytes = Buffer.alloc(dataStart + types.reduce((n, s) => n + Buffer.byteLength(s) + 2, 0));
  bytes.write('dex\n035\0', 0, 'ascii');
  const put = (offset, value) => bytes.writeUInt32LE(value, offset);
  put(32, bytes.length);
  put(36, 112);
  put(40, 0x12345678);
  put(56, types.length);
  put(60, stringStart);
  put(64, types.length);
  put(68, typeStart);
  put(96, definitions.length);
  put(100, classStart);
  let offset = dataStart;
  for (let i = 0; i < types.length; i++) {
    put(stringStart + i * 4, offset);
    put(typeStart + i * 4, i);
    bytes[offset++] = types[i].length;
    offset += bytes.write(types[i], offset, 'utf8');
    bytes[offset++] = 0;
  }
  definitions.forEach((index, i) => put(classStart + i * 32, index));
  return bytes;
}

test('reads type definitions without executing code', () => {
  const result = inspectDex(dex(['Lexample/Source;', 'Landroid/webkit/WebView;'], [0]));
  assert.deepEqual(result.defined, ['Lexample/Source;']);
  assert.equal(result.types[1], 'Landroid/webkit/WebView;');
});
test('rejects truncated headers, tables, strings and invalid type indexes', () => {
  const valid = dex(['Lexample/Source;'], [0]);
  assert.throws(() => inspectDex(valid.subarray(0, 100)), /invalid_dex/);
  for (const [offset, value] of [
    [32, 112],
    [60, 0xffffffff],
    [112, 0xffffffff],
    [116, 100],
    [120, 100],
  ]) {
    const changed = Buffer.from(valid);
    changed.writeUInt32LE(value, offset);
    assert.throws(() => inspectDex(changed), /invalid_dex/);
  }
  const noTerminator = Buffer.from(valid);
  noTerminator[noTerminator.length - 1] = 1;
  assert.throws(() => inspectDex(noTerminator), /invalid_dex/);
});
test('merges multi-dex definitions before classifying Android dependencies', async () => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add('AndroidManifest.xml', new Uint8ArrayReader(new Uint8Array([0])));
  await writer.add(
    'classes.dex',
    new Uint8ArrayReader(dex(['Lexample/Source;', 'Lexample/Helper;', 'Landroid/webkit/WebView;'], [0])),
  );
  await writer.add('classes2.dex', new Uint8ArrayReader(dex(['Lexample/Helper;'], [0])));
  const report = await inspectApk(await writer.close());
  assert.equal(report.dexFiles, 2);
  assert.equal(report.definedClasses, 2);
  assert.deepEqual(report.external, ['Landroid/webkit/WebView;']);
  assert.equal(report.features.webView, true);
  assert.equal(report.features.nativeLibraries, false);
});
test('rejects ordinary ZIP archives and APKs without a manifest', async () => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add('classes.dex', new Uint8ArrayReader(dex(['Lexample/Source;'], [0])));
  await assert.rejects(inspectApk(await writer.close()), /invalid_apk/);
});
